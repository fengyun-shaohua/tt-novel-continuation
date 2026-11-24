import { getContext } from '/scripts/extensions.js';
import {
    METADATA_KEY,
    createNewWorldInfo,
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    world_names,
} from '/scripts/world-info.js';
import { inspectBatchExtractionQuality } from './story-archiver.js';

export const EXTENSION_NAMESPACE = 'novel-continuation';

const KEY_NOVEL_DATA = 'novel_data_v1';
const KEY_LEDGER = 'timeline_ledger_v1';
const KEY_CANON_DB = 'canon_db_v1';
const CHAT_SCOPE_META_KEY = 'novelContinuationScopeId';

const memoryStoreCache = new Map();

export const DEFAULT_NARRATIVE_CONFIG = Object.freeze({
    povMode: 'auto', // 'auto' | 'strict_limited'
    povCharacter: '',
    povPerson: 'follow_original', // 'follow_original' | 'first_person' | 'third_limited'
    worldInfoMode: 'bridge', // 'bridge' | 'off'
    worldInfoPriority: 'novel_over_wi', // 'novel_over_wi' | 'wi_strict'
    worldInfoBudgetChars: 12000,
    strictTimelineOrder: true,
    excludeFlashbackFromAnchor: true,
    referenceTimelineMode: false,
    referencePovLabel: '',
    referenceCursorChapter: 0,
    referenceLookaheadChapters: 8,
    autoAdvanceRefCursor: true,
    autoDetectOnArchive: true,
});

export function normalizeNarrativeConfig(raw = null) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const povMode = src.povMode === 'strict_limited' ? 'strict_limited' : 'auto';
    const povPerson = ['follow_original', 'first_person', 'third_limited'].includes(src.povPerson)
        ? src.povPerson
        : 'follow_original';
    const worldInfoMode = src.worldInfoMode === 'off' ? 'off' : 'bridge';
    const worldInfoPriority = src.worldInfoPriority === 'wi_strict' ? 'wi_strict' : 'novel_over_wi';
    const budget = Number(src.worldInfoBudgetChars);
    const worldInfoBudgetChars = Number.isFinite(budget)
        ? Math.max(2000, Math.min(40000, Math.round(budget)))
        : DEFAULT_NARRATIVE_CONFIG.worldInfoBudgetChars;
    return {
        povMode,
        povCharacter: String(src.povCharacter || '').trim(),
        povPerson,
        worldInfoMode,
        worldInfoPriority,
        worldInfoBudgetChars,
        strictTimelineOrder: src.strictTimelineOrder !== false,
        excludeFlashbackFromAnchor: src.excludeFlashbackFromAnchor !== false,
        referenceTimelineMode: Boolean(src.referenceTimelineMode),
        referencePovLabel: String(src.referencePovLabel || '').trim(),
        referenceCursorChapter: Number.isFinite(Number(src.referenceCursorChapter)) && Number(src.referenceCursorChapter) >= 0
            ? Math.floor(Number(src.referenceCursorChapter))
            : 0,
        referenceLookaheadChapters: Number.isFinite(Number(src.referenceLookaheadChapters))
            ? Math.max(2, Math.min(20, Math.floor(Number(src.referenceLookaheadChapters))))
            : 8,
        autoAdvanceRefCursor: src.autoAdvanceRefCursor !== false,
        autoDetectOnArchive: src.autoDetectOnArchive !== false,
    };
}

export function normalizeTimelineRole(role) {
    return (role === 'reference' || role === 'flashback' || role === 'skip') ? role : 'main';
}

export const DEFAULT_STORY_BLUEPRINT = Object.freeze({
    creationMode: 'continuation', // 'continuation' | 'original' | 'fanfic_new'
    title: '',
    genreAndTone: '',
    seedNotes: '',
    premise: '',
    worldRules: '',
    endingDirection: '',
    volumes: [],
    updatedAt: 0,
});

export function normalizeStoryVolume(raw, fallbackIndex = 1) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const index = Number.isFinite(Number(src.index)) && Number(src.index) >= 1
        ? Math.floor(Number(src.index))
        : Math.max(1, fallbackIndex);
    const chapterRange = String(src.chapterRange || '').trim();
    const nums = [...chapterRange.matchAll(/\d+/g)].map(m => Number(m[0])).filter(n => n > 0);
    const startChapter = Number.isFinite(Number(src.startChapter)) && Number(src.startChapter) >= 1
        ? Math.floor(Number(src.startChapter))
        : (nums[0] || ((index - 1) * 15 + 1));
    const endChapter = Number.isFinite(Number(src.endChapter)) && Number(src.endChapter) >= startChapter
        ? Math.floor(Number(src.endChapter))
        : (nums[nums.length - 1] >= startChapter ? nums[nums.length - 1] : startChapter + 14);
    const status = ['planned', 'active', 'completed'].includes(src.status) ? src.status : 'planned';
    return {
        id: String(src.id || `vol_${index}_${Date.now().toString(36)}`).trim(),
        index,
        title: String(src.title || `第 ${index} 卷`).trim() || `第 ${index} 卷`,
        chapterRange: chapterRange || `第 ${startChapter}~${endChapter} 章`,
        startChapter,
        endChapter,
        goal: String(src.goal || '').trim(),
        keyTurns: String(src.keyTurns || '').trim(),
        endingHook: String(src.endingHook || '').trim(),
        status,
        recap: String(src.recap || '').trim(),
        recapCheck: String(src.recapCheck || '').trim(),
        recapUpdatedAt: Number(src.recapUpdatedAt || 0),
    };
}

export function normalizeStoryBlueprint(raw = null) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const creationMode = ['continuation', 'original', 'fanfic_new'].includes(src.creationMode)
        ? src.creationMode
        : 'continuation';
    const volumes = Array.isArray(src.volumes)
        ? src.volumes.map((v, i) => normalizeStoryVolume(v, i + 1))
        : [];
    return {
        creationMode,
        title: String(src.title || '').trim(),
        genreAndTone: String(src.genreAndTone || '').trim(),
        seedNotes: String(src.seedNotes || '').trim(),
        premise: String(src.premise || '').trim(),
        worldRules: String(src.worldRules || '').trim(),
        endingDirection: String(src.endingDirection || '').trim(),
        volumes,
        updatedAt: Number(src.updatedAt || 0),
    };
}

export function hasStoryBlueprint(blueprint) {
    if (!blueprint || typeof blueprint !== 'object') return false;
    return Boolean(
        String(blueprint.title || '').trim()
        || String(blueprint.premise || '').trim()
        || String(blueprint.seedNotes || '').trim()
        || String(blueprint.worldRules || '').trim()
        || (Array.isArray(blueprint.volumes) && blueprint.volumes.length > 0),
    );
}

export function resolveBookTitle(novelData, ledger) {
    const fromNovel = String(novelData?.title || '').trim();
    if (fromNovel) return fromNovel;
    const fromBlueprint = String(ledger?.storyBlueprint?.title || '').trim();
    if (fromBlueprint) return fromBlueprint;
    return '当前长篇小说';
}

export function reindexNovelChapters(novelData) {
    if (!novelData || !Array.isArray(novelData.chapters)) return novelData;
    const prevCutoff = Number(novelData.cutoffChapterIndex || novelData.chapters.length || 0);
    const prevViewing = Number(novelData.viewingChapterIndex || prevCutoff || 1);
    const chapters = novelData.chapters
        .filter(c => c && typeof c === 'object')
        .map((c, idx) => {
            const content = String(c.content || '').trim();
            return {
                ...c,
                index: idx + 1,
                title: String(c.title || `第 ${idx + 1} 章`).trim() || `第 ${idx + 1} 章`,
                content,
                wordCount: content.replace(/\s+/g, '').length,
                timelineRole: normalizeTimelineRole(c.timelineRole),
            };
        });
    const totalChapters = chapters.length;
    const cutoffChapterIndex = totalChapters > 0
        ? Math.max(1, Math.min(prevCutoff || totalChapters, totalChapters))
        : 0;
    const viewingChapterIndex = totalChapters > 0
        ? Math.max(1, Math.min(prevViewing || cutoffChapterIndex, totalChapters))
        : 0;
    return {
        ...novelData,
        chapters,
        totalChapters,
        cutoffChapterIndex,
        viewingChapterIndex,
    };
}

export function createEmptyLedger() {
    return {
        summaries: [],
        chronicle: [],
        characters: [],
        worldStates: [],
        hooks: [],
        styleProfile: null,
        narrativeConfig: normalizeNarrativeConfig(),
        storyBlueprint: normalizeStoryBlueprint(),
        refCursorBase: null,
        refCursorHistory: {},
        lastArchivedChapter: 0,
        archiveBatches: [],
        archiveNeedsResynth: false,
        archiveProcessLog: [],
        draftOutline: null,
        latestRewriteReport: null,
    };
}

export function createEmptyCanonDb() {
    return {
        sources: [],
        items: [],
    };
}

function hashToScopeKey(rawScope) {
    let hash = 2166136261;
    for (let i = 0; i < rawScope.length; i += 1) {
        hash ^= rawScope.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    const hex = (hash >>> 0).toString(16).padStart(8, '0');
    const asciiPrefix = rawScope.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'chat';
    return `chat_${asciiPrefix}_${hex}`;
}

/**
 * Resolves a strict per-conversation (对话级) scope key stored in `context.chatMetadata.novelContinuationScopeId`
 * and/or derived from the current conversation's `chatId`.
 * Different chats under the same character card are 100% isolated and never share or leak novels.
 *
 * @param {{ createIfMissing?: boolean }} [options]
 * @returns {string | null}
 */
export function getPersistentScopeKey({ createIfMissing = false } = {}) {
    const context = getContext();
    if (!context) return null;

    const existingMetaScope = String(context.chatMetadata?.[CHAT_SCOPE_META_KEY] || '').trim();
    if (existingMetaScope) {
        return existingMetaScope;
    }

    const rawChatId = String(context.chatId || context.getCurrentChatId?.() || '').trim();
    const hasActiveConversation = Boolean(
        rawChatId
        || context.groupId
        || (context.characterId !== undefined && context.characterId !== null),
    );
    if (!hasActiveConversation) {
        return null;
    }

    if (rawChatId) {
        const scopeKey = hashToScopeKey(rawChatId);
        if (createIfMissing && context.chatMetadata) {
            context.chatMetadata[CHAT_SCOPE_META_KEY] = scopeKey;
            context.chatMetadata.tainted = true;
            context.saveMetadataDebounced?.();
        }
        return scopeKey;
    }

    if (!createIfMissing) {
        return null;
    }

    const generated = `chat_uid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (context.chatMetadata) {
        context.chatMetadata[CHAT_SCOPE_META_KEY] = generated;
        context.chatMetadata.tainted = true;
        context.saveMetadataDebounced?.();
    }
    return generated;
}

/**
 * Resolves the TauriTavern `api.extension.store` adapter strictly scoped to the current conversation.
 */
function getExtensionStoreAdapter() {
    const extStore = globalThis.__TAURITAVERN__?.api?.extension?.store;
    if (!extStore) return null;

    const makeKey = (scope, key) => `${scope}__${key}`;

    return {
        async get(key) {
            const scope = getPersistentScopeKey({ createIfMissing: false });
            if (!scope) return null;
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
                return null;
            } catch {
                return null;
            }
        },
        async set(key, value) {
            const scope = getPersistentScopeKey({ createIfMissing: true });
            if (!scope) {
                throw new Error('当前未打开具体对话，请先进入一个角色卡对话后再保存小说数据');
            }
            const primaryKey = makeKey(scope, key);
            memoryStoreCache.set(primaryKey, value);
            await extStore.setJson({
                namespace: EXTENSION_NAMESPACE,
                table: 'chat_scoped',
                key: primaryKey,
                value,
            });
            const context = getContext();
            if (context?.chatMetadata) {
                context.chatMetadata[CHAT_SCOPE_META_KEY] = scope;
                context.chatMetadata.tainted = true;
                try {
                    await context.saveMetadata?.();
                } catch {
                    context.saveMetadataDebounced?.();
                }
            }
        },
        async remove(key) {
            const scope = getPersistentScopeKey({ createIfMissing: false });
            if (!scope) return;
            const k = makeKey(scope, key);
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
        chapters: data.chapters.map(c => (c && typeof c === 'object'
            ? { ...c, timelineRole: normalizeTimelineRole(c.timelineRole) }
            : c)),
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

function migrateBatchesFromLegacyLog(archiveProcessLog) {
    if (!Array.isArray(archiveProcessLog) || archiveProcessLog.length === 0) return [];
    const recovered = [];
    for (const item of archiveProcessLog) {
        if (!item?.id || !/^batch_(\d+)$/.test(item.id)) continue;
        const idxMatch = item.id.match(/^batch_(\d+)$/);
        const rangeMatch = String(item.title || '').match(/第\s*(\d+)\s*~\s*(\d+)\s*章/);
        const charMatch = String(item.title || '').match(/（(\d+)\s*字）/);
        if (!idxMatch || !rangeMatch) continue;
        const notes = String(item.detail || '');
        const quality = inspectBatchExtractionQuality(notes);
        recovered.push({
            batchIndex: Number(idxMatch[1]),
            startChapter: Number(rangeMatch[1]),
            endChapter: Number(rangeMatch[2]),
            chapterTitles: [],
            charCount: charMatch ? Number(charMatch[1]) : 0,
            status: quality.status,
            statusNote: quality.statusNote,
            notes,
            updatedAt: Date.now(),
        });
    }
    return recovered.sort((a, b) => a.batchIndex - b.batchIndex);
}

export async function loadLedger() {
    const store = getExtensionStoreAdapter();
    if (!store) return createEmptyLedger();
    const raw = await store.get(KEY_LEDGER);
    if (!raw || typeof raw !== 'object') return createEmptyLedger();
    const rawLog = Array.isArray(raw.archiveProcessLog) ? raw.archiveProcessLog : [];
    const archiveBatches = Array.isArray(raw.archiveBatches) && raw.archiveBatches.length > 0
        ? raw.archiveBatches
        : migrateBatchesFromLegacyLog(rawLog);
    return {
        summaries: Array.isArray(raw.summaries) ? raw.summaries : [],
        chronicle: Array.isArray(raw.chronicle) ? raw.chronicle : [],
        characters: Array.isArray(raw.characters) ? raw.characters : [],
        worldStates: Array.isArray(raw.worldStates) ? raw.worldStates : [],
        hooks: Array.isArray(raw.hooks) ? raw.hooks : [],
        styleProfile: raw.styleProfile && typeof raw.styleProfile === 'object' ? raw.styleProfile : null,
        narrativeConfig: normalizeNarrativeConfig(raw.narrativeConfig),
        storyBlueprint: normalizeStoryBlueprint(raw.storyBlueprint),
        refCursorBase: Number.isFinite(Number(raw.refCursorBase)) ? Number(raw.refCursorBase) : null,
        refCursorHistory: raw.refCursorHistory && typeof raw.refCursorHistory === 'object' ? raw.refCursorHistory : {},
        lastArchivedChapter: Number(raw.lastArchivedChapter || 0),
        archiveBatches,
        archiveNeedsResynth: Boolean(raw.archiveNeedsResynth),
        archiveProcessLog: rawLog,
        draftOutline: raw.draftOutline && typeof raw.draftOutline === 'object' ? raw.draftOutline : null,
        latestRewriteReport: raw.latestRewriteReport && typeof raw.latestRewriteReport === 'object' ? raw.latestRewriteReport : null,
    };
}

export async function saveLedger(ledger) {
    const store = getExtensionStoreAdapter();
    if (!store) return;
    await store.set(KEY_LEDGER, ledger);
}

function hooksMatchLoosely(a, b) {
    const sa = String(a || '').replace(/[\s，。！？、：；“”"'（）()\[\]【】]/g, '');
    const sb = String(b || '').replace(/[\s，。！？、：；“”"'（）()\[\]【】]/g, '');
    if (!sa || !sb) return false;
    if (sa === sb || sa.includes(sb.slice(0, 8)) || sb.includes(sa.slice(0, 8))) return true;
    const minLen = Math.min(sa.length, sb.length);
    if (minLen < 4) return false;
    const bigramsA = new Set();
    for (let i = 0; i < sa.length - 1; i += 1) bigramsA.add(sa.slice(i, i + 2));
    let shared = 0;
    const totalB = Math.max(1, sb.length - 1);
    for (let i = 0; i < sb.length - 1; i += 1) {
        if (bigramsA.has(sb.slice(i, i + 2))) shared += 1;
    }
    return shared >= 3 && shared / Math.min(bigramsA.size, totalB) >= 0.45;
}

/**
 * Merges structured full-novel or incremental archiver output into the single-truth ledger,
 * preserving user-pinned hooks and manual edits when running incrementally.
 */
export async function mergeArchivedDataIntoLedger(archiveResult, { mode = 'full' } = {}) {
    const ledger = await loadLedger();
    const isFull = mode === 'full';

    if (Array.isArray(archiveResult.chronicle) && archiveResult.chronicle.length > 0) {
        if (isFull) {
            ledger.chronicle = archiveResult.chronicle;
        } else {
            const byKey = new Map(ledger.chronicle.map(e => [`${e.chapterRange}|${e.title}`, e]));
            for (const evt of archiveResult.chronicle) {
                byKey.set(`${evt.chapterRange}|${evt.title}`, evt);
            }
            ledger.chronicle = [...byKey.values()].sort((a, b) => (a.startChapter || 0) - (b.startChapter || 0));
        }
    }

    if (Array.isArray(archiveResult.characters) && archiveResult.characters.length > 0) {
        // Always merge by character name so planned/un-debuted blueprint characters & manual canonFoundation are never erased
        const byName = new Map(ledger.characters.map(c => [String(c.name || '').trim().toLowerCase(), c]));
        for (const ch of archiveResult.characters) {
            const key = String(ch.name || '').trim().toLowerCase();
            if (!key) continue;
            const prev = byName.get(key);
            byName.set(key, prev ? {
                ...prev,
                role: ch.role || prev.role,
                canonFoundation: ch.canonFoundation || prev.canonFoundation,
                currentAppearance: ch.currentAppearance || prev.currentAppearance || '',
                currentSituation: ch.currentSituation || prev.currentSituation,
                voiceAndQuotes: ch.voiceAndQuotes || prev.voiceAndQuotes,
                oocRedLines: ch.oocRedLines || prev.oocRedLines,
                updatedChapter: ch.updatedChapter || prev.updatedChapter,
            } : ch);
        }
        ledger.characters = [...byName.values()];
    }

    if (Array.isArray(archiveResult.worldStates) && archiveResult.worldStates.length > 0) {
        for (const ws of archiveResult.worldStates) {
            const idx = ledger.worldStates.findIndex(w => w.name === ws.name && w.category === ws.category);
            if (idx >= 0) ledger.worldStates[idx] = ws;
            else ledger.worldStates.push(ws);
        }
    }

    if (Array.isArray(archiveResult.hooks) && archiveResult.hooks.length > 0) {
        const manualHooks = ledger.hooks.filter(h => !h.autoExtracted);
        const existingAuto = isFull ? [] : ledger.hooks.filter(h => h.autoExtracted);
        const combined = [...manualHooks, ...existingAuto];
        for (const incoming of archiveResult.hooks) {
            const match = combined.find(h => hooksMatchLoosely(h.content, incoming.content));
            if (match) {
                if (incoming.status === 'resolved' && match.status !== 'resolved') {
                    match.status = 'resolved';
                    match.resolvedChapter = incoming.resolvedChapter || archiveResult.lastArchivedChapter;
                }
            } else {
                combined.push(incoming);
            }
        }
        ledger.hooks = combined;
    }

    ledger.lastArchivedChapter = Math.max(
        isFull ? 0 : Number(ledger.lastArchivedChapter || 0),
        Number(archiveResult.lastArchivedChapter || 0),
    );
    if (Array.isArray(archiveResult.batches)) {
        ledger.archiveBatches = archiveResult.batches;
    }
    ledger.archiveNeedsResynth = false;
    if (Array.isArray(archiveResult.processLog)) {
        ledger.archiveProcessLog = archiveResult.processLog;
    } else if (archiveResult.synthLogEntry) {
        const filtered = (ledger.archiveProcessLog || []).filter(l => l.id !== 'synth_complete');
        ledger.archiveProcessLog = [...filtered, archiveResult.synthLogEntry];
    }

    await saveLedger(ledger);
    return ledger;
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
    ledger.chronicle = (ledger.chronicle || []).filter(e => Number(e.startChapter || 0) <= maxChapterIndex);
    ledger.archiveBatches = (ledger.archiveBatches || []).filter(b => Number(b.startChapter || 0) <= maxChapterIndex);
    ledger.worldStates = ledger.worldStates.filter(w => Number(w.effectiveChapter || 0) <= maxChapterIndex);
    ledger.hooks = ledger.hooks.filter(h => Number(h.plantedChapter || 0) <= maxChapterIndex);
    for (const hook of ledger.hooks) {
        if (hook.status === 'resolved' && Number(hook.resolvedChapter || 0) > maxChapterIndex) {
            hook.status = 'open';
            delete hook.resolvedChapter;
        }
    }
    if (Number(ledger.lastArchivedChapter || 0) > maxChapterIndex) {
        ledger.lastArchivedChapter = maxChapterIndex;
    }
    if (ledger.refCursorHistory && typeof ledger.refCursorHistory === 'object') {
        const kept = {};
        let bestCh = -1;
        let restoredCursor = Number.isFinite(Number(ledger.refCursorBase)) ? Number(ledger.refCursorBase) : null;
        for (const [k, v] of Object.entries(ledger.refCursorHistory)) {
            const chNum = Number(k);
            if (Number.isFinite(chNum) && chNum <= maxChapterIndex) {
                kept[k] = v;
                if (chNum > bestCh && Number.isFinite(Number(v))) {
                    bestCh = chNum;
                    restoredCursor = Number(v);
                }
            }
        }
        ledger.refCursorHistory = kept;
        if (restoredCursor !== null && ledger.narrativeConfig?.referenceTimelineMode && ledger.narrativeConfig?.autoAdvanceRefCursor !== false) {
            ledger.narrativeConfig.referenceCursorChapter = restoredCursor;
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

    // Sync explicit appearance/clothing updates back to matching character profiles
    const appearList = Array.isArray(extracted.appearanceUpdates) ? extracted.appearanceUpdates : [];
    for (const ap of appearList) {
        if (!ap?.name || !ap?.appearance) continue;
        const targetChar = (ledger.characters || []).find(
            c => c?.name && String(c.name).trim().toLowerCase() === String(ap.name).trim().toLowerCase(),
        );
        if (targetChar) {
            targetChar.currentAppearance = ap.appearance;
            targetChar.updatedChapter = Math.max(Number(targetChar.updatedChapter || 0), chapterIndex);
        }
    }

    for (const hook of extracted.hooks || []) {
        if (!hook.content) continue;
        if (hook.action === 'resolve') {
            const target = ledger.hooks.find(
                h => h.status !== 'resolved' && hooksMatchLoosely(h.content, hook.content),
            );
            if (target) {
                target.status = 'resolved';
                target.resolvedChapter = chapterIndex;
            }
        } else {
            const exists = ledger.hooks.some(h => h.status !== 'resolved' && hooksMatchLoosely(h.content, hook.content));
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

    // Auto-advance (or swipe-update) parallel reference cursor when enabled
    if (
        Number.isFinite(Number(extracted.refCursor))
        && Number(extracted.refCursor) >= 0
        && ledger.narrativeConfig?.referenceTimelineMode
        && ledger.narrativeConfig?.autoAdvanceRefCursor !== false
    ) {
        const curCursor = Number(ledger.narrativeConfig.referenceCursorChapter || 0);
        if (!Number.isFinite(Number(ledger.refCursorBase))) {
            ledger.refCursorBase = curCursor;
        }
        const incomingCursor = Math.floor(Number(extracted.refCursor));
        ledger.refCursorHistory = ledger.refCursorHistory && typeof ledger.refCursorHistory === 'object'
            ? ledger.refCursorHistory
            : {};
        ledger.refCursorHistory[String(chapterIndex)] = incomingCursor;

        // Recompute monotonic effective frontier across ALL recorded chapters so swiping the latest
        // chapter can update/rewind while swiping an older chapter never regresses the active frontier.
        let effectiveMaxCursor = Number(ledger.refCursorBase || 0);
        for (const v of Object.values(ledger.refCursorHistory)) {
            const cVal = Number(v);
            if (Number.isFinite(cVal) && cVal >= 0) {
                effectiveMaxCursor = Math.max(effectiveMaxCursor, cVal);
            }
        }
        ledger.narrativeConfig.referenceCursorChapter = effectiveMaxCursor;
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
