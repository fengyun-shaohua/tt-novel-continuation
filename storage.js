import { getContext } from '/scripts/extensions.js';
import {
    METADATA_KEY,
    createNewWorldInfo,
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    world_names,
} from '/scripts/world-info.js';

export const EXTENSION_NAMESPACE = 'novel-continuation';

const KEY_NOVEL_DATA = 'novel_data_v1';
const KEY_LEDGER = 'timeline_ledger_v1';
const KEY_CANON_DB = 'canon_db_v1';

export function createEmptyLedger() {
    return {
        summaries: [],
        worldStates: [],
        hooks: [],
    };
}

export function createEmptyCanonDb() {
    return {
        sources: [],
        items: [],
    };
}

function getStableChatKey() {
    const context = getContext();
    const rawId = String(context?.getCurrentChatId?.() || context?.chatId || '').trim();
    return rawId || null;
}

/**
 * Resolves the active chat's TauriTavern store adapter.
 * Uses `listKeys` before `getJson` / `deleteJson` so Tauri's `safeInvoke` never triggers
 * a red "后端错误: Chat store entry not found" toast when a chat has no novel data yet.
 */
function getActiveChatStore() {
    const tt = globalThis.__TAURITAVERN__?.api;
    try {
        const handle = tt?.chat?.current?.handle?.();
        if (handle?.store && typeof handle.store.listKeys === 'function') {
            return {
                async get(key) {
                    try {
                        const keys = await handle.store.listKeys({ namespace: EXTENSION_NAMESPACE });
                        if (!Array.isArray(keys) || !keys.includes(key)) {
                            return null;
                        }
                        return await handle.store.getJson({ namespace: EXTENSION_NAMESPACE, key });
                    } catch {
                        return null;
                    }
                },
                async set(key, value) {
                    await handle.store.setJson({ namespace: EXTENSION_NAMESPACE, key, value });
                },
                async remove(key) {
                    try {
                        const keys = await handle.store.listKeys({ namespace: EXTENSION_NAMESPACE });
                        if (Array.isArray(keys) && keys.includes(key)) {
                            await handle.store.deleteJson({ namespace: EXTENSION_NAMESPACE, key });
                        }
                    } catch {
                        // Ignore
                    }
                },
            };
        }
    } catch {
        // Fall through to extension.store
    }

    const extStore = tt?.extension?.store;
    const chatId = getStableChatKey();
    if (extStore && chatId) {
        const scopedKey = (key) => `${chatId}__${key}`;
        return {
            async get(key) {
                const res = await extStore.tryGetJson({
                    namespace: EXTENSION_NAMESPACE,
                    table: 'chat_scoped',
                    key: scopedKey(key),
                });
                return res?.found ? res.value : null;
            },
            async set(key, value) {
                await extStore.setJson({
                    namespace: EXTENSION_NAMESPACE,
                    table: 'chat_scoped',
                    key: scopedKey(key),
                    value,
                });
            },
            async remove(key) {
                await extStore.deleteJson({
                    namespace: EXTENSION_NAMESPACE,
                    table: 'chat_scoped',
                    key: scopedKey(key),
                });
            },
        };
    }

    return null;
}

/**
 * Loads the imported original novel for the current chat.
 */
export async function loadNovelData() {
    const store = getActiveChatStore();
    if (!store) return null;
    const data = await store.get(KEY_NOVEL_DATA);
    if (!data || !Array.isArray(data.chapters)) return null;
    return {
        title: data.title || '未命名小说',
        totalChapters: data.totalChapters || data.chapters.length,
        cutoffChapterIndex: Number.isFinite(data.cutoffChapterIndex) && data.cutoffChapterIndex > 0
            ? data.cutoffChapterIndex
            : data.chapters.length,
        chapters: data.chapters,
    };
}

export async function saveNovelData(novelData) {
    const store = getActiveChatStore();
    if (!store) throw new Error('请先打开一个角色聊天后再导入小说数据');
    await store.set(KEY_NOVEL_DATA, novelData);
}

export async function clearNovelData() {
    const store = getActiveChatStore();
    if (store) await store.remove(KEY_NOVEL_DATA);
}

export async function loadLedger() {
    const store = getActiveChatStore();
    if (!store) return createEmptyLedger();
    const raw = await store.get(KEY_LEDGER);
    if (!raw || typeof raw !== 'object') return createEmptyLedger();
    return {
        summaries: Array.isArray(raw.summaries) ? raw.summaries : [],
        worldStates: Array.isArray(raw.worldStates) ? raw.worldStates : [],
        hooks: Array.isArray(raw.hooks) ? raw.hooks : [],
    };
}

export async function saveLedger(ledger) {
    const store = getActiveChatStore();
    if (!store) return;
    await store.set(KEY_LEDGER, ledger);
}

export async function loadCanonDb() {
    const store = getActiveChatStore();
    if (!store) return createEmptyCanonDb();
    const raw = await store.get(KEY_CANON_DB);
    if (!raw || typeof raw !== 'object') return createEmptyCanonDb();
    return {
        sources: Array.isArray(raw.sources) ? raw.sources : [],
        items: Array.isArray(raw.items) ? raw.items : [],
    };
}

export async function saveCanonDb(canonDb) {
    const store = getActiveChatStore();
    if (!store) throw new Error('请先打开一个角色聊天后再挂载补充设定库');
    await store.set(KEY_CANON_DB, canonDb);
}

/**
 * Rolls back all ledger records (summaries, character states, hooks) generated after `maxChapterIndex`.
 * Used when truncating/rewriting from an earlier chapter or deleting floors.
 *
 * @param {number} maxChapterIndex
 */
export async function pruneLedgerAfterChapter(maxChapterIndex) {
    const ledger = await loadLedger();
    ledger.summaries = ledger.summaries.filter(s => Number(s.chapterIndex || 0) <= maxChapterIndex);
    ledger.worldStates = ledger.worldStates.filter(w => Number(w.effectiveChapter || 0) <= maxChapterIndex);
    ledger.hooks = ledger.hooks.filter(h => Number(h.plantedChapter || 0) <= maxChapterIndex);
    for (const hook of ledger.hooks) {
        if (hook.status === 'resolved' && Number(hook.resolvedChapter || 0) > maxChapterIndex) {
            hook.status = 'open';
            delete hook.resolvedChapter;
        }
    }
    await saveLedger(ledger);
    return ledger;
}

/**
 * Applies `<novel_state>` updates extracted from a single-call AI chapter generation
 * into the timeline ledger. Automatically replaces any prior records from the same
 * `chapterIndex` or `floorIndex` so Regenerate / Swipe never leaves stale branch state.
 */
export async function applyExtractedStateToLedger(extracted, chapterIndex, chapterTitle, floorIndex = null) {
    const ledger = await loadLedger();
    const now = Date.now();

    // 1. Roll back previous records belonging to this same chapterIndex or floorIndex
    ledger.summaries = ledger.summaries.filter(
        s => s.chapterIndex !== chapterIndex && (floorIndex === null || s.floorIndex !== floorIndex),
    );
    ledger.worldStates = ledger.worldStates.filter(
        w => w.effectiveChapter !== chapterIndex && (floorIndex === null || w.floorIndex !== floorIndex),
    );
    ledger.hooks = ledger.hooks.filter(
        h => !(h.autoExtracted && (h.plantedChapter === chapterIndex || (floorIndex !== null && h.floorIndex === floorIndex))),
    );
    for (const h of ledger.hooks) {
        if (h.status === 'resolved' && h.resolvedChapter === chapterIndex) {
            h.status = 'open';
            delete h.resolvedChapter;
        }
    }

    // 2. Insert new summary
    if (extracted.summary) {
        ledger.summaries.push({
            chapterIndex,
            floorIndex,
            title: chapterTitle || `第 ${chapterIndex} 章`,
            summary: extracted.summary,
            updatedAt: now,
        });
        ledger.summaries.sort((a, b) => a.chapterIndex - b.chapterIndex);
    }

    // 3. Insert new world states for this chapter
    for (const item of extracted.worldUpdates || []) {
        if (!item.name || !item.state) continue;
        ledger.worldStates.push({
            id: `${item.category}_${item.name}_ch${chapterIndex}`,
            category: item.category || '人物',
            name: item.name,
            state: item.state,
            effectiveChapter: chapterIndex,
            floorIndex,
            updatedAt: now,
        });
    }

    // 4. Apply hook additions and resolutions
    for (const hook of extracted.hooks || []) {
        if (!hook.content) continue;
        if (hook.action === 'resolve') {
            const target = ledger.hooks.find(
                h => h.status !== 'resolved' && (h.content.includes(hook.content.slice(0, 8)) || hook.content.includes(h.content.slice(0, 8))),
            );
            if (target) {
                target.status = 'resolved';
                target.resolvedChapter = chapterIndex;
            }
        } else {
            const exists = ledger.hooks.some(h => h.content === hook.content);
            if (!exists) {
                ledger.hooks.push({
                    id: `hook_${now}_${Math.random().toString(36).slice(2, 7)}`,
                    content: hook.content,
                    plantedChapter: chapterIndex,
                    floorIndex,
                    autoExtracted: true,
                    status: 'open',
                });
            }
        }
    }

    await saveLedger(ledger);
    return ledger;
}

/**
 * Synchronizes extracted character/world state updates directly into SillyTavern's native World Info
 * lorebook bound to the current chat (`chat_metadata.world_info`), replacing same-chapter lines on regenerate.
 */
export async function syncWorldUpdatesToTavernLorebook(novelTitle, worldUpdates, chapterIndex) {
    if (!Array.isArray(worldUpdates) || worldUpdates.length === 0) return null;
    const context = getContext();
    if (!context?.chatMetadata) return null;

    let bookName = context.chatMetadata[METADATA_KEY];
    if (!bookName) {
        const sanitizedTitle = String(novelTitle || '小说续写')
            .replace(/[\\/:*?"<>|\s]+/g, '_')
            .slice(0, 24);
        const chatSuffix = String(getStableChatKey() || 'chat')
            .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '')
            .slice(-8) || 'default';
        bookName = `续写_${sanitizedTitle}_${chatSuffix}`;
        if (!Array.isArray(world_names) || !world_names.includes(bookName)) {
            const created = await createNewWorldInfo(bookName, { interactive: false });
            if (!created) return null;
        }
        context.chatMetadata[METADATA_KEY] = bookName;
        context.saveMetadataDebounced?.();
    }

    const data = await loadWorldInfo(bookName);
    if (!data || typeof data.entries !== 'object') return null;

    const chapterPrefix = `【第 ${chapterIndex} 章状态】`;

    for (const update of worldUpdates) {
        const entryTitle = `[${update.category}] ${update.name}`;
        let targetEntry = Object.values(data.entries).find(
            e => e && (e.comment === entryTitle || (Array.isArray(e.key) && e.key.includes(update.name))),
        );
        if (!targetEntry) {
            targetEntry = createWorldInfoEntry(bookName, data);
            if (!targetEntry) continue;
            targetEntry.comment = entryTitle;
            targetEntry.key = [update.name];
        }
        const stamp = `${chapterPrefix}${update.state}`;
        const existingLines = String(targetEntry.content || '')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && l !== entryTitle && !l.startsWith(chapterPrefix));
        const kept = existingLines.slice(-5);
        kept.push(stamp);
        targetEntry.content = [entryTitle, ...kept].join('\n');
    }

    await saveWorldInfo(bookName, data, true);
    return bookName;
}
