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
const GLOBAL_FALLBACK_SCOPE = 'global_default_scope';

const memoryStoreCache = new Map();

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
 * Resolves a persistent scope identifier that survives exiting/re-entering a blank character card.
 * Prioritizes the character's stable `avatar` filename (or `groupId`), falling back to `GLOBAL_FALLBACK_SCOPE`
 * so importing on a blank character card or welcome screen never loses data when chat filenames change.
 */
export function getPersistentScopeKey() {
    const context = getContext();
    const chid = context?.characterId;
    const character = (chid !== undefined && chid !== null && Array.isArray(context?.characters))
        ? context.characters[chid]
        : null;

    const rawScope = String(
        character?.avatar
        || context?.groupId
        || (context?.name2 && context.name2 !== 'SillyTavern System' ? context.name2 : '')
        || GLOBAL_FALLBACK_SCOPE,
    ).trim();

    let hash = 2166136261;
    for (let i = 0; i < rawScope.length; i += 1) {
        hash ^= rawScope.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    const hex = (hash >>> 0).toString(16).padStart(8, '0');
    const asciiPrefix = rawScope.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'scope';
    return `${asciiPrefix}_${hex}`;
}

/**
 * Resolves the TauriTavern `api.extension.store` adapter.
 * Also supports falling back to the global scope if the user imported a novel on the welcome screen
 * and then switched into a blank character card.
 */
function getExtensionStoreAdapter() {
    const extStore = globalThis.__TAURITAVERN__?.api?.extension?.store;
    if (!extStore) return null;

    const makeKey = (scope, key) => `${scope}__${key}`;

    return {
        async get(key) {
            const scope = getPersistentScopeKey();
            const primaryKey = makeKey(scope, key);
            if (memoryStoreCache.has(primaryKey)) {
                return memoryStoreCache.get(primaryKey);
            }
            try {
                const res = await extStore.tryGetJson({
                    namespace: EXTENSION_NAMESPACE,
                    table: 'chat_scoped',
                    key: primaryKey,
                });
                if (res?.found && res.value !== null && res.value !== undefined) {
                    memoryStoreCache.set(primaryKey, res.value);
                    return res.value;
                }
                // Fallback: check global latest novel if current blank character has none yet
                const fallbackKey = makeKey(GLOBAL_FALLBACK_SCOPE, key);
                if (scope !== GLOBAL_FALLBACK_SCOPE) {
                    const fallbackRes = await extStore.tryGetJson({
                        namespace: EXTENSION_NAMESPACE,
                        table: 'chat_scoped',
                        key: fallbackKey,
                    });
                    if (fallbackRes?.found && fallbackRes.value) {
                        memoryStoreCache.set(primaryKey, fallbackRes.value);
                        return fallbackRes.value;
                    }
                }
                return null;
            } catch {
                return null;
            }
        },
        async set(key, value) {
            const scope = getPersistentScopeKey();
            const primaryKey = makeKey(scope, key);
            memoryStoreCache.set(primaryKey, value);
            await extStore.setJson({
                namespace: EXTENSION_NAMESPACE,
                table: 'chat_scoped',
                key: primaryKey,
                value,
            });
            // Also mirror to global fallback scope so switching from welcome screen or blank card keeps it accessible
            const fallbackKey = makeKey(GLOBAL_FALLBACK_SCOPE, key);
            memoryStoreCache.set(fallbackKey, value);
            await extStore.setJson({
                namespace: EXTENSION_NAMESPACE,
                table: 'chat_scoped',
                key: fallbackKey,
                value,
            });
        },
        async remove(key) {
            const scope = getPersistentScopeKey();
            for (const s of new Set([scope, GLOBAL_FALLBACK_SCOPE])) {
                const k = makeKey(s, key);
                memoryStoreCache.delete(k);
                try {
                    await extStore.deleteJson({
                        namespace: EXTENSION_NAMESPACE,
                        table: 'chat_scoped',
                        key: k,
                    });
                } catch {
                    // Ignore
                }
            }
        },
    };
}

/**
 * Loads the imported original novel for the current character/chat.
 */
export async function loadNovelData() {
    const store = getExtensionStoreAdapter();
    if (!store) return null;
    const data = await store.get(KEY_NOVEL_DATA);
    if (!data || !Array.isArray(data.chapters) || data.chapters.length === 0) return null;
    return {
        title: data.title || '未命名小说',
        totalChapters: data.totalChapters || data.chapters.length,
        cutoffChapterIndex: Number.isFinite(data.cutoffChapterIndex) && data.cutoffChapterIndex > 0
            ? data.cutoffChapterIndex
            : data.chapters.length,
        viewingChapterIndex: Number.isFinite(data.viewingChapterIndex) && data.viewingChapterIndex > 0
            ? data.viewingChapterIndex
            : (data.cutoffChapterIndex || data.chapters.length),
        chapters: data.chapters,
    };
}

export async function saveNovelData(novelData) {
    const store = getExtensionStoreAdapter();
    if (!store) throw new Error('TauriTavern 扩展存储未就绪');
    await store.set(KEY_NOVEL_DATA, novelData);
}

export async function clearNovelData() {
    const store = getExtensionStoreAdapter();
    if (store) await store.remove(KEY_NOVEL_DATA);
}

export async function loadLedger() {
    const store = getExtensionStoreAdapter();
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
    const store = getExtensionStoreAdapter();
    if (!store) return;
    await store.set(KEY_LEDGER, ledger);
}

export async function loadCanonDb() {
    const store = getExtensionStoreAdapter();
    if (!store) return createEmptyCanonDb();
    const raw = await store.get(KEY_CANON_DB);
    if (!raw || typeof raw !== 'object') return createEmptyCanonDb();
    return {
        sources: Array.isArray(raw.sources) ? raw.sources : [],
        items: Array.isArray(raw.items) ? raw.items : [],
    };
}

export async function saveCanonDb(canonDb) {
    const store = getExtensionStoreAdapter();
    if (!store) throw new Error('TauriTavern 扩展存储未就绪');
    await store.set(KEY_CANON_DB, canonDb);
}

/**
 * Rolls back all ledger records (summaries, character states, hooks) generated after `maxChapterIndex`.
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
 * into the timeline ledger.
 */
export async function applyExtractedStateToLedger(extracted, chapterIndex, chapterTitle, floorIndex = null) {
    const ledger = await loadLedger();
    const now = Date.now();

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
 * Synchronizes extracted character/world state updates directly into SillyTavern's native World Info.
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
        const scopeSuffix = getPersistentScopeKey().slice(-8);
        bookName = `续写_${sanitizedTitle}_${scopeSuffix}`;
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
