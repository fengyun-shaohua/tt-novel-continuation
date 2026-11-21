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

/**
 * Default empty timeline ledger structure (Pagekin-style per-chapter state & foreshadowing ledger).
 */
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

/**
 * Resolves the active chat's TauriTavern store adapter.
 * Falls back to global extension.store scoped by chatId when chat handle is unavailable.
 */
function getActiveChatStore() {
    const tt = globalThis.__TAURITAVERN__?.api;
    try {
        const handle = tt?.chat?.current?.handle?.();
        if (handle?.store) {
            return {
                async get(key) {
                    try {
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
                        await handle.store.deleteJson({ namespace: EXTENSION_NAMESPACE, key });
                    } catch {
                        // Ignore missing key on delete
                    }
                },
            };
        }
    } catch {
        // Fall through to extension.store
    }

    const extStore = tt?.extension?.store;
    const chatId = String(getContext()?.getCurrentChatId?.() || getContext()?.chatId || 'default_chat');
    const scopedKey = (key) => `${chatId}__${key}`;

    if (extStore) {
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
 * @returns {Promise<{ title: string, totalChapters: number, cutoffChapterIndex: number, chapters: Array<{ index: number, title: string, content: string, wordCount: number }> } | null>}
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

/**
 * Persists the imported original novel for the current chat.
 */
export async function saveNovelData(novelData) {
    const store = getActiveChatStore();
    if (!store) throw new Error('TauriTavern 扩展存储尚未就绪，请先打开一个角色聊天');
    await store.set(KEY_NOVEL_DATA, novelData);
}

export async function clearNovelData() {
    const store = getActiveChatStore();
    if (store) await store.remove(KEY_NOVEL_DATA);
}

/**
 * Loads the timeline ledger (summaries, per-chapter character/world states, foreshadowing hooks).
 */
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

/**
 * Loads the supplementary fanfic/canon database for the current chat.
 */
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
    if (!store) throw new Error('TauriTavern 扩展存储尚未就绪');
    await store.set(KEY_CANON_DB, canonDb);
}

/**
 * Applies `<novel_state>` updates extracted from a single-call AI chapter generation
 * into the timeline ledger, tagging all entries with `effectiveChapter` for timeline isolation.
 *
 * @param {{ summary: string, worldUpdates: Array<{ category: string, name: string, state: string }>, hooks: Array<{ action: 'add' | 'resolve', content: string }> }} extracted
 * @param {number} chapterIndex
 * @param {string} chapterTitle
 */
export async function applyExtractedStateToLedger(extracted, chapterIndex, chapterTitle) {
    const ledger = await loadLedger();
    const now = Date.now();

    if (extracted.summary) {
        const existingIdx = ledger.summaries.findIndex(s => s.chapterIndex === chapterIndex);
        const record = {
            chapterIndex,
            title: chapterTitle || `第 ${chapterIndex} 章`,
            summary: extracted.summary,
            updatedAt: now,
        };
        if (existingIdx !== -1) {
            ledger.summaries[existingIdx] = record;
        } else {
            ledger.summaries.push(record);
            ledger.summaries.sort((a, b) => a.chapterIndex - b.chapterIndex);
        }
    }

    for (const item of extracted.worldUpdates || []) {
        if (!item.name || !item.state) continue;
        ledger.worldStates.push({
            id: `${item.category}_${item.name}_ch${chapterIndex}`,
            category: item.category || '人物',
            name: item.name,
            state: item.state,
            effectiveChapter: chapterIndex,
            updatedAt: now,
        });
    }

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
 * lorebook bound to the current chat (`chat_metadata.world_info`), creating one if needed.
 *
 * @param {string} novelTitle
 * @param {Array<{ category: string, name: string, state: string }>} worldUpdates
 * @param {number} chapterIndex
 */
export async function syncWorldUpdatesToTavernLorebook(novelTitle, worldUpdates, chapterIndex) {
    if (!Array.isArray(worldUpdates) || worldUpdates.length === 0) return null;
    const context = getContext();
    if (!context?.chatMetadata) return null;

    let bookName = context.chatMetadata[METADATA_KEY];
    if (!bookName) {
        const sanitizedTitle = String(novelTitle || '小说续写')
            .replace(/[\\/:*?"<>|\s]+/g, '_')
            .slice(0, 32);
        bookName = `续写设定_${sanitizedTitle}`;
        if (!Array.isArray(world_names) || !world_names.includes(bookName)) {
            const created = await createNewWorldInfo(bookName, { interactive: false });
            if (!created) return null;
        }
        context.chatMetadata[METADATA_KEY] = bookName;
        context.saveMetadataDebounced?.();
    }

    const data = await loadWorldInfo(bookName);
    if (!data || typeof data.entries !== 'object') return null;

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
        const stamp = `【第 ${chapterIndex} 章状态】${update.state}`;
        if (!targetEntry.content) {
            targetEntry.content = `${entryTitle}\n${stamp}`;
        } else if (!targetEntry.content.includes(stamp)) {
            const lines = targetEntry.content.split('\n').filter(Boolean);
            const kept = lines.slice(-6);
            kept.push(stamp);
            targetEntry.content = kept.join('\n');
        }
    }

    await saveWorldInfo(bookName, data, true);
    return bookName;
}
