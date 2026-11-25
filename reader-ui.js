import { escapeHtml, debounce } from '/scripts/utils.js';
import { getContext } from '/scripts/extensions.js';
import { isBoundedChatSurfaceView, jumpBoundedChatSurfaceToMessage, resetChatSurfaceView } from '/script.js';
import { DEFAULT_CLICHE_TERMS } from './cliche-guard.js';
import { hasStoryBlueprintData, isContinuedNovelFloor, resolveActiveVolume } from './context-assembler.js';
import { stripNonStoryBlocks } from './parser.js';
import {
    listGlobalLorePacks,
    loadActiveLoreBundle,
    loadCanonDb,
    loadLedger,
    loadNovelData,
    normalizeNarrativeConfig,
    normalizeRecastConfig,
    normalizeRecastMapping,
    normalizeStoryBlueprint,
    normalizeStoryVolume,
    saveCanonDb,
    saveLedger,
} from './storage.js';

const PROGRESS_META_KEY = 'novel_continuation_progress';
const TOC_PAGE_LIMIT = 100;

/* ==========================================================================
   Monochrome Inline Vector Icons (14px Geometric Stroke, Zero Emojis)
   ========================================================================== */
const SVG_PATHS = Object.freeze({
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronUp: '<path d="m18 15-6-6-6 6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    refresh: '<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
});

function uiIcon(name, size = 14) {
    const body = SVG_PATHS[name] || '';
    return `<svg class="tt-svg-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function statusDot(tone = 'idle') {
    return `<span class="tt-dot is-${escapeHtml(tone)}" aria-hidden="true"></span>`;
}

/* ==========================================================================
   Workbench State (5 Clean Top-Level Tabs + Sub-Tabs)
   ========================================================================== */
let workbenchOpen = false;
let activeTab = 'create';      // 'create' | 'memory' | 'craft' | 'toc' | 'settings'
let createSubTab = 'scene';    // 'scene' | 'recast' | 'blueprint'
let memoryFilter = 'chars';    // 'chars' | 'chronicle' | 'hooks' | 'world' | 'canon'
let craftSubTab = 'style';     // 'style' | 'rewrite'
let settingsFocusSection = ''; // '' | 'model' | 'narrative' | 'files' | 'bridge'

let showAllOriginalChapters = false;
let editingCharacterId = null;
let editingEventId = null;
let editingHookId = null;
let editingWorldStateId = null;
let editingSummaryChapter = null;
let editingCanonId = null;
let canonSearchQuery = '';
let editingChapterIndex = null;
let addingChapterOpen = false;
let tocBulkRangeText = '';

let cachedNovelData = null;
let cachedLedger = null;
let cachedCanonDb = null;
let cachedGlobalLorePacks = [];
let cachedActiveLoreBundle = { items: [], worldCores: [], activePacks: [] };
let cachedAnchorInfo = null;
let handlers = {};

let recastDraftUi = null; // In-progress local copy of recast mappings so typing/adding rows stays responsive
let recastDraftScope = null;

const outlineDraftUiState = {
    userBrief: '',
    chapterCount: 3,
    sceneCount: 4,
    paceMode: 'slow',
    selectedHookIds: null, // null = auto-inherit pinned hooks
    initializedForScope: null,
    blueprintVolumeCount: 4,
    blueprintChaptersPerVol: 15,
};

const customStyleUiState = {
    styleBrief: '',
    referenceSample: '',
};

const liveTaskState = {
    memory: { running: false, text: '', error: false, logs: [] },
    outline: { running: false, text: '', error: false },
    style: { running: false, text: '', error: false, logs: [] },
    cliche: { running: false, text: '', error: false },
};
let lastBridgeUi = { state: 'disconnected', detail: '未连接外部 Agent' };

function resolveTabRoute(tabName) {
    if (!tabName) return null;
    if (tabName === 'outline') return { tab: 'create', sub: 'scene' };
    if (tabName === 'recast') return { tab: 'create', sub: 'recast' };
    if (tabName === 'blueprint') return { tab: 'create', sub: 'blueprint' };
    if (tabName === 'create') return { tab: 'create', sub: null };
    if (tabName === 'memory') return { tab: 'memory', sub: null };
    if (tabName === 'style') return { tab: 'craft', sub: 'style' };
    if (tabName === 'cliche' || tabName === 'rewrite') return { tab: 'craft', sub: 'rewrite' };
    if (tabName === 'craft') return { tab: 'craft', sub: null };
    if (tabName === 'toc') return { tab: 'toc', sub: null };
    if (tabName === 'settings') return { tab: 'settings', sub: null };
    return null;
}

function taskBelongsToActiveTab(taskKey) {
    if (taskKey === 'outline') return activeTab === 'create';
    if (taskKey === 'memory') return activeTab === 'memory';
    if (taskKey === 'style' || taskKey === 'cliche') return activeTab === 'craft';
    return false;
}

/**
 * Applies or removes the body CSS classes for Immersive Novel Mode, Hide User Floors, and Hide Reasoning.
 */
export function applyReaderBodyClasses(settings) {
    const active = settings?.enabled !== false;
    document.body.classList.toggle('tt-novel-immersive', active && Boolean(settings?.immersiveMode));
    document.body.classList.toggle('tt-novel-hide-user-floors', active && Boolean(settings?.hideUserFloors));
    document.body.classList.toggle('tt-novel-hide-cot', active && settings?.hideReasoning !== false);

    const bar = document.getElementById('tt-novel-quickbar');
    if (bar) {
        bar.classList.toggle('displayNone', !active);
    }
    if (!active && workbenchOpen) {
        closeWorkbench();
    }
    syncQuickBarState(settings);
}

/**
 * Mounts the ultra-slim single-row mini bar above `#send_form` and the Editorial Minimal Workbench modal.
 */
export function mountReaderUi(uiHandlers) {
    handlers = uiHandlers || {};
    mountMiniQuickBar();
    mountWorkbenchModal();
    installScrollProgressTracker();
    applyReaderBodyClasses(handlers.getSettings?.() || {});
}

function mountMiniQuickBar() {
    if (document.getElementById('tt-novel-quickbar')) return;
    const sendForm = document.getElementById('send_form') || document.getElementById('form_sheld');
    if (!sendForm) return;

    const bar = document.createElement('div');
    bar.id = 'tt-novel-quickbar';
    bar.className = 'tt-novel-quickbar';
    bar.innerHTML = `
        <button type="button" id="tt-novel-btn-immersive" class="tt-novel-pill" title="切换沉浸小说阅读排版">
            ${uiIcon('book', 13)} <span>沉浸</span>
        </button>
        <button type="button" id="tt-novel-btn-prev-ch" class="tt-novel-pill tt-novel-pill-icon displayNone" title="上一章">
            ${uiIcon('chevronLeft', 14)}
        </button>
        <button type="button" id="tt-novel-btn-next-ch" class="tt-novel-pill tt-novel-pill-icon displayNone" title="下一章">
            ${uiIcon('chevronRight', 14)}
        </button>
        <button type="button" id="tt-novel-btn-toc" class="tt-novel-pill" title="章节目录">
            ${uiIcon('list', 13)} <span id="tt-novel-toc-badge">目录</span>
        </button>
        <button type="button" id="tt-novel-btn-workbench" class="tt-novel-pill tt-novel-pill-accent" title="打开小说工作台">
            ${uiIcon('layers', 13)} <span>工作台</span>
            <span id="tt-novel-wb-badge" class="tt-novel-mini-badge displayNone"></span>
        </button>
    `;

    sendForm.parentElement?.insertBefore(bar, sendForm);

    bar.querySelector('#tt-novel-btn-immersive')?.addEventListener('click', () => {
        handlers.onToggleSetting?.('immersiveMode');
    });
    bar.querySelector('#tt-novel-btn-prev-ch')?.addEventListener('click', async () => {
        if (!cachedNovelData?.totalChapters) return;
        const curr = getCurrentVisibleOriginalChapterIndex()
            || Number(cachedNovelData.viewingChapterIndex || cachedNovelData.cutoffChapterIndex || 1);
        await handlers.onViewChapter?.(Math.max(1, curr - 1));
    });
    bar.querySelector('#tt-novel-btn-next-ch')?.addEventListener('click', async () => {
        if (!cachedNovelData?.totalChapters) return;
        const curr = getCurrentVisibleOriginalChapterIndex()
            || Number(cachedNovelData.viewingChapterIndex || cachedNovelData.cutoffChapterIndex || 1);
        await handlers.onViewChapter?.(Math.min(cachedNovelData.totalChapters, curr + 1));
    });
    bar.querySelector('#tt-novel-btn-toc')?.addEventListener('click', () => {
        void openWorkbench('toc');
    });
    bar.querySelector('#tt-novel-btn-workbench')?.addEventListener('click', () => {
        void openWorkbench(activeTab || 'create');
    });

    syncQuickBarState(handlers.getSettings?.() || {});
}

export function syncQuickBarState(settings) {
    const btnImmersive = document.getElementById('tt-novel-btn-immersive');
    if (btnImmersive) {
        btnImmersive.classList.toggle('active', Boolean(settings?.immersiveMode));
    }
}

function mountWorkbenchModal() {
    if (document.getElementById('tt-novel-wb-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'tt-novel-wb-overlay';
    overlay.className = 'tt-novel-wb-overlay displayNone';
    overlay.innerHTML = `
        <div class="tt-novel-wb-modal" role="dialog" aria-modal="true" aria-label="小说工作台">
            <header class="tt-novel-wb-header">
                <div class="tt-novel-wb-title-wrap">
                    <div id="tt-novel-wb-title" class="tt-novel-wb-title">小说工作台</div>
                    <div id="tt-novel-wb-subtitle" class="tt-novel-wb-subtitle"></div>
                </div>
                <button type="button" id="tt-novel-wb-close" class="tt-novel-icon-btn" title="关闭">
                    ${uiIcon('close', 15)}
                </button>
            </header>
            <nav class="tt-novel-wb-tabs" id="tt-novel-wb-tabs" role="tablist">
                <button type="button" class="tt-novel-wb-tab" data-tab="create" role="tab">创作</button>
                <button type="button" class="tt-novel-wb-tab" data-tab="memory" role="tab">设定</button>
                <button type="button" class="tt-novel-wb-tab" data-tab="craft" role="tab">文风<span id="tt-novel-tab-cliche-dot" class="tt-novel-tab-dot displayNone"></span></button>
                <button type="button" class="tt-novel-wb-tab" data-tab="toc" role="tab">目录</button>
                <button type="button" class="tt-novel-wb-tab" data-tab="settings" role="tab">设置</button>
            </nav>
            <main id="tt-novel-wb-body" class="tt-novel-wb-body"></main>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeWorkbench();
    });
    overlay.querySelector('#tt-novel-wb-close')?.addEventListener('click', () => closeWorkbench());
    overlay.querySelectorAll('.tt-novel-wb-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.getAttribute('data-tab') || 'create';
            if (activeTab !== 'settings') settingsFocusSection = '';
            renderWorkbench();
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && workbenchOpen) {
            closeWorkbench();
        }
    });
}

export async function openWorkbench(tabName, options = {}) {
    const routed = resolveTabRoute(tabName);
    if (routed) {
        activeTab = routed.tab;
        if (routed.tab === 'create' && routed.sub) createSubTab = routed.sub;
        if (routed.tab === 'craft' && routed.sub) craftSubTab = routed.sub;
    }
    if (options.settingsSection) {
        settingsFocusSection = String(options.settingsSection);
    } else if (activeTab !== 'settings') {
        settingsFocusSection = '';
    }
    workbenchOpen = true;
    const overlay = document.getElementById('tt-novel-wb-overlay');
    if (overlay) {
        overlay.classList.remove('displayNone');
    }
    await refreshReaderWidgets();
}

export function closeWorkbench() {
    workbenchOpen = false;
    editingCharacterId = null;
    editingEventId = null;
    editingHookId = null;
    editingWorldStateId = null;
    editingSummaryChapter = null;
    editingCanonId = null;
    const overlay = document.getElementById('tt-novel-wb-overlay');
    if (overlay) {
        overlay.classList.add('displayNone');
    }
}

/**
 * Updates live task progress and appends streaming step/round cards directly inside the Workbench.
 */
export function updateLiveProgress(tabName, { text = '', isRunning = false, isError = false, logEntry = null, resetLogs = false } = {}) {
    const bucket = liveTaskState[tabName];
    if (!bucket) return;
    bucket.running = isRunning;
    bucket.text = text;
    bucket.error = isError;
    if (resetLogs && Array.isArray(bucket.logs)) {
        bucket.logs = [];
    }
    if (logEntry && Array.isArray(bucket.logs)) {
        const idx = bucket.logs.findIndex(item => item.id && item.id === logEntry.id);
        if (idx >= 0) bucket.logs[idx] = logEntry;
        else bucket.logs.push(logEntry);
    }
    if (workbenchOpen && taskBelongsToActiveTab(tabName)) {
        renderWorkbench();
    }
}

export function updateBridgeStatusUi({ state, detail }) {
    lastBridgeUi = { state: state || 'disconnected', detail: detail || state || '' };
    const statusEl = document.getElementById('tt-novel-bridge-status');
    if (statusEl) {
        const tone = state === 'connected' ? 'ok' : (state === 'connecting' ? 'warn' : (state === 'error' ? 'error' : 'idle'));
        statusEl.innerHTML = `${statusDot(tone)} ${escapeHtml(lastBridgeUi.detail)}`;
    }
}

/**
 * Refreshes cached book/ledger/canon data, updates the mini bar badge, and re-renders Workbench if open.
 */
export async function refreshReaderWidgets() {
    const [novelData, ledger, canonDb, globalPacks, anchorInfo] = await Promise.all([
        loadNovelData(),
        loadLedger(),
        loadCanonDb(),
        listGlobalLorePacks(),
        handlers.getLatestChapterAnchorInfo?.() ?? null,
    ]);
    const loreBundle = await loadActiveLoreBundle(ledger, canonDb);
    cachedNovelData = novelData;
    cachedLedger = ledger;
    cachedCanonDb = canonDb;
    cachedGlobalLorePacks = Array.isArray(globalPacks) ? globalPacks : [];
    cachedActiveLoreBundle = loreBundle || { items: [], worldCores: [], activePacks: [] };
    cachedAnchorInfo = anchorInfo;

    const currentChatKey = String(getContext()?.chatId || novelData?.title || '');
    if (recastDraftScope !== currentChatKey) {
        recastDraftScope = currentChatKey;
        recastDraftUi = null;
    }
    if (outlineDraftUiState.initializedForScope !== currentChatKey) {
        outlineDraftUiState.initializedForScope = currentChatKey;
        const saved = ledger?.draftOutline;
        outlineDraftUiState.userBrief = saved?.userBrief || '';
        outlineDraftUiState.chapterCount = Number(saved?.chapterCount || 3);
        outlineDraftUiState.sceneCount = Number(saved?.sceneCount || 4);
        outlineDraftUiState.paceMode = saved?.paceMode || 'slow';
        outlineDraftUiState.selectedHookIds = Array.isArray(saved?.selectedHookIds) ? [...saved.selectedHookIds] : null;
        // On a brand-new 0-chapter chat with no blueprint yet, default Create tab to Blueprint
        if (!novelData?.chapters?.length && !hasStoryBlueprintData(ledger?.storyBlueprint)) {
            createSubTab = 'blueprint';
        }
    }

    const hasOrig = Boolean(novelData?.totalChapters > 0);
    document.getElementById('tt-novel-btn-prev-ch')?.classList.toggle('displayNone', !hasOrig);
    document.getElementById('tt-novel-btn-next-ch')?.classList.toggle('displayNone', !hasOrig);

    const badge = document.getElementById('tt-novel-toc-badge');
    if (badge) {
        if (novelData?.totalChapters) {
            badge.textContent = `目录 ${novelData.cutoffChapterIndex}/${novelData.totalChapters}`;
        } else if (Number(anchorInfo?.continuedCount || 0) > 0) {
            badge.textContent = `目录 ${anchorInfo.continuedCount}章`;
        } else {
            badge.textContent = '目录';
        }
    }

    const wbBadge = document.getElementById('tt-novel-wb-badge');
    const clicheDot = document.getElementById('tt-novel-tab-cliche-dot');
    const clicheInfo = handlers.getLatestClicheStatus?.();
    const clicheHits = Number(clicheInfo?.report?.totalHits || 0);
    const openHooksCount = (ledger?.hooks || []).filter(h => h.status !== 'resolved').length;

    if (wbBadge) {
        if (clicheHits > 0) {
            wbBadge.textContent = `${clicheHits}`;
            wbBadge.className = 'tt-novel-mini-badge is-warn';
        } else if (openHooksCount > 0) {
            wbBadge.textContent = `${openHooksCount}`;
            wbBadge.className = 'tt-novel-mini-badge';
        } else {
            wbBadge.className = 'tt-novel-mini-badge displayNone';
        }
    }
    if (clicheDot) {
        if (clicheHits > 0) {
            clicheDot.textContent = `${clicheHits}`;
            clicheDot.classList.remove('displayNone');
        } else {
            clicheDot.classList.add('displayNone');
        }
    }

    if (workbenchOpen) {
        renderWorkbench();
    }
}

function renderWorkbench() {
    const titleEl = document.getElementById('tt-novel-wb-title');
    const subEl = document.getElementById('tt-novel-wb-subtitle');
    const bodyEl = document.getElementById('tt-novel-wb-body');
    if (!bodyEl) return;

    const meta = handlers.getRuntimeMeta?.() || {};
    const bp = cachedLedger?.storyBlueprint;
    if (titleEl) {
        if (cachedNovelData?.title) {
            titleEl.textContent = `《${cachedNovelData.title}》`;
        } else if (bp?.title) {
            titleEl.textContent = `《${bp.title}》`;
        } else {
            titleEl.textContent = '小说工作台';
        }
    }
    if (subEl) {
        const settings = handlers.getSettings?.() || {};
        const continuedCount = Number(cachedAnchorInfo?.continuedCount || 0);
        const parts = [];
        if (cachedNovelData?.totalChapters) {
            parts.push(`锚点 #${cachedNovelData.cutoffChapterIndex}/${cachedNovelData.totalChapters}`);
        } else if (hasStoryBlueprintData(bp) || continuedCount > 0) {
            const modeTag = bp?.creationMode === 'fanfic_new' ? '同人新开坑' : '原创';
            parts.push(`${modeTag} · 已写 ${continuedCount} 章`);
        }
        parts.push(meta.activeModel || '当前酒馆模型');
        if (settings.autoDeepRewrite) parts.push('自动重塑已开');
        subEl.textContent = parts.join(' · ');
    }

    document.querySelectorAll('#tt-novel-wb-tabs .tt-novel-wb-tab').forEach(btn => {
        const isCurrent = btn.getAttribute('data-tab') === activeTab;
        btn.classList.toggle('active', isCurrent);
        btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    });

    if (activeTab === 'create') renderCreateTab(bodyEl);
    else if (activeTab === 'memory') renderMemoryTab(bodyEl);
    else if (activeTab === 'craft') renderCraftTab(bodyEl);
    else if (activeTab === 'toc') renderTocTab(bodyEl);
    else if (activeTab === 'settings') renderSettingsTab(bodyEl);

    bodyEl.querySelectorAll('[data-action="stop-task"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-task');
            if (key) handlers.onStopTask?.(key);
        });
    });
}

function renderTaskProgressBanner(taskKey, task) {
    if (!task?.text && !task?.running) return '';
    const cls = task.error ? 'is-error' : (task.running ? 'is-running' : 'is-ok');
    const dotTone = task.error ? 'error' : (task.running ? 'running' : 'ok');
    const stopBtn = task.running
        ? `<button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-stop" data-action="stop-task" data-task="${escapeHtml(taskKey)}">${uiIcon('stop', 12)} 停止</button>`
        : '';
    return `
        <div class="tt-novel-banner tt-novel-banner-row ${cls}">
            <span class="tt-novel-banner-text">${statusDot(dotTone)} ${escapeHtml(task.text)}</span>
            ${stopBtn}
        </div>
    `;
}

/* ==========================================================================
   TAB 1: 创作 (Segmented: 本章分镜 | 换角仿写 | 全书总纲)
   ========================================================================== */
function renderCreateTab(bodyEl) {
    const ledger = cachedLedger || { chronicle: [], characters: [], hooks: [], styleProfile: null, draftOutline: null, storyBlueprint: null };
    const bp = normalizeStoryBlueprint(ledger.storyBlueprint);
    const nCfg = normalizeNarrativeConfig(ledger.narrativeConfig);
    const recastCfg = nCfg.recast;
    const task = liveTaskState.outline;
    const volCountBadge = bp.volumes.length > 0 ? ` (${bp.volumes.length}卷)` : '';
    const recastBadge = recastCfg.enabled ? ` (#${recastCfg.sourceCursorChapter})` : '';

    const segHtml = `
        <div class="tt-novel-seg is-3" role="tablist">
            <button type="button" class="tt-novel-seg-btn ${createSubTab === 'scene' ? 'active' : ''}" data-create-sub="scene">本章分镜</button>
            <button type="button" class="tt-novel-seg-btn ${createSubTab === 'recast' ? 'active' : ''}" data-create-sub="recast">换角仿写${recastBadge}</button>
            <button type="button" class="tt-novel-seg-btn ${createSubTab === 'blueprint' ? 'active' : ''}" data-create-sub="blueprint">全书总纲${volCountBadge}</button>
        </div>
    `;

    const progressHtml = renderTaskProgressBanner('outline', task);

    if (createSubTab === 'blueprint') {
        renderBlueprintSubView(bodyEl, segHtml, progressHtml, ledger, bp, task);
    } else if (createSubTab === 'recast') {
        renderRecastSubView(bodyEl, segHtml, progressHtml, ledger, nCfg, task);
    } else {
        renderSceneOutlineSubView(bodyEl, segHtml, progressHtml, ledger, bp, task);
    }

    bodyEl.querySelectorAll('[data-create-sub]').forEach(btn => {
        btn.addEventListener('click', () => {
            createSubTab = btn.getAttribute('data-create-sub') || 'scene';
            renderWorkbench();
        });
    });
}

function renderRecastSubView(bodyEl, segHtml, progressHtml, ledger, nCfg, task) {
    const hasNovel = Boolean(cachedNovelData?.chapters?.length);
    const totalCh = Number(cachedNovelData?.chapters?.length || 0);
    if (!recastDraftUi) {
        const saved = normalizeRecastConfig(nCfg.recast);
        recastDraftUi = {
            ...saved,
            mappings: saved.mappings.length > 0
                ? saved.mappings.map(m => ({ ...m }))
                : [normalizeRecastMapping({ fromName: '', toName: '', toProfile: '', note: '' }, 0)],
        };
    }

    const curCursor = hasNovel
        ? Math.max(1, Math.min(totalCh, Number(recastDraftUi.sourceCursorChapter) || 1))
        : Math.max(1, Number(recastDraftUi.sourceCursorChapter) || 1);
    recastDraftUi.sourceCursorChapter = curCursor;
    const srcChapter = hasNovel
        ? (cachedNovelData.chapters.find(c => Number(c.index) === curCursor) || cachedNovelData.chapters[curCursor - 1])
        : null;
    const activePackNames = (cachedActiveLoreBundle?.activePacks || []).map(p => p.name).filter(Boolean);

    const chapterOptionsHtml = hasNovel
        ? cachedNovelData.chapters.map(c => (
            `<option value="${c.index}" ${Number(c.index) === curCursor ? 'selected' : ''}>#${c.index} ${escapeHtml(String(c.title || `第 ${c.index} 章`).slice(0, 32))}</option>`
        )).join('')
        : '<option value="1">尚未导入原著</option>';

    const mappingsHtml = recastDraftUi.mappings.map((m, idx) => `
        <div class="tt-novel-recast-row" data-recast-row="${escapeHtml(m.id)}">
            <div class="tt-novel-recast-pair">
                <input type="text" class="text_pole" data-rc-field="fromName" value="${escapeHtml(m.fromName || '')}" placeholder="原著角色名（如原女主）" />
                <span class="tt-novel-recast-arrow">替换为</span>
                <input type="text" class="text_pole" data-rc-field="toName" value="${escapeHtml(m.toName || '')}" placeholder="新角色名（如白金 / 塑心 / 椿）" />
                <button type="button" class="menu_button tt-novel-btn-sm" data-rc-action="lookup" data-id="${escapeHtml(m.id)}" title="从已导入资料库查人并自动填入底骨">${uiIcon('book', 12)} 查资料库</button>
                <button type="button" class="tt-novel-mini-icon-btn" data-rc-action="del" data-id="${escapeHtml(m.id)}" title="删除此映射" ${recastDraftUi.mappings.length <= 1 ? 'disabled' : ''}>${uiIcon('trash', 13)}</button>
            </div>
            <textarea class="text_pole" rows="3" data-rc-field="toProfile" placeholder="新角色外貌着装、性格底色、能力与说话语气（点右侧「查资料库」可自动填入；留空在开写时也会自动从已启用资料库精准召回）">${escapeHtml(m.toProfile || '')}</textarea>
            <input type="text" class="text_pole" data-rc-field="note" value="${escapeHtml(m.note || '')}" placeholder="因果与关系适配说明（可选，例如：保留主线相遇场景，但以她的性格初期保持疏离吐槽）" />
        </div>
    `).join('');

    const srcPreviewText = srcChapter?.content
        ? stripNonStoryBlocks(srcChapter.content).slice(0, 600)
        : '';

    bodyEl.innerHTML = `
        ${segHtml}
        <div class="tt-novel-context-strip">
            <span class="tt-novel-context-main">
                ${hasNovel
                    ? (recastDraftUi.enabled
                        ? `换角仿写已开启 · 下一章对照原著 #${curCursor}/${totalCh}《${escapeHtml(srcChapter?.title || `第 ${curCursor} 章`)}》`
                        : `原著已导入（${totalCh} 章）· 开启下方开关即可逐章替换角色仿写`)
                    : '请先在「设置 → 作品导入」导入想模仿的原著小说 TXT / MD'}
            </span>
            <div class="tt-novel-context-links">
                <button type="button" class="tt-novel-link-pill" data-jump-lore="1">
                    ${activePackNames.length > 0 ? `资料库：${escapeHtml(activePackNames.join(' / '))}` : '去挂载同人资料库'}
                </button>
            </div>
        </div>
        ${progressHtml}

        <section class="tt-novel-card">
            <div class="tt-novel-edit-grid">
                <label class="tt-novel-toggle-row">
                    <input type="checkbox" id="tt-novel-rc-enabled" ${recastDraftUi.enabled ? 'checked' : ''} />
                    <div>
                        <div class="tt-novel-toggle-title">启用逐章换角仿写模式</div>
                        <div class="tt-novel-toggle-desc">自动把原著第 N 章作为文风与剧情骨架范本，强制剥离被替换原名，并按新角色资料库底骨防换皮 OOC</div>
                    </div>
                </label>

                <div class="tt-novel-row-2">
                    <label>当前对照原著章节
                        <div class="tt-novel-bridge-row">
                            <button type="button" id="tt-novel-rc-prev" class="menu_button tt-novel-btn-sm" ${!hasNovel || curCursor <= 1 ? 'disabled' : ''}>${uiIcon('chevronLeft', 12)}</button>
                            <select id="tt-novel-rc-cursor" class="text_pole" ${!hasNovel ? 'disabled' : ''}>${chapterOptionsHtml}</select>
                            <button type="button" id="tt-novel-rc-next" class="menu_button tt-novel-btn-sm" ${!hasNovel || curCursor >= totalCh ? 'disabled' : ''}>${uiIcon('chevronRight', 12)}</button>
                        </div>
                    </label>
                    <label>改编保真度
                        <select id="tt-novel-rc-fidelity" class="text_pole">
                            <option value="strict" ${recastDraftUi.fidelity === 'strict' ? 'selected' : ''}>紧贴原著分镜（只换人设与反应）</option>
                            <option value="balanced" ${recastDraftUi.fidelity === 'balanced' ? 'selected' : ''}>保主线顺因果（推荐，允许自然涟漪）</option>
                            <option value="free" ${recastDraftUi.fidelity === 'free' ? 'selected' : ''}>借骨架自由重塑（只借开场与文风）</option>
                        </select>
                    </label>
                </div>

                <label class="tt-novel-check-row">
                    <input type="checkbox" id="tt-novel-rc-auto-adv" ${recastDraftUi.autoAdvanceCursor !== false ? 'checked' : ''} />
                    <span>每写完一章自动推进对照原著指针到下一章（Swipe 或删除章节时自动回退同步）</span>
                </label>

                ${srcPreviewText ? `
                    <details class="tt-novel-subtle-fold">
                        <summary>预览原著第 ${curCursor} 章《${escapeHtml(srcChapter?.title || '')}》片段（共 ${Number(srcChapter?.wordCount || srcChapter?.content?.length || 0)} 字）</summary>
                        <div class="tt-novel-pre-wrap" style="margin-top: 6px;">${escapeHtml(srcPreviewText)}${srcChapter.content.length > 600 ? '……' : ''}</div>
                    </details>
                ` : ''}
            </div>
        </section>

        <section class="tt-novel-section">
            <div class="tt-novel-card-head">
                <div class="tt-novel-section-title">角色替换映射表（支持单女主或多人替换）</div>
                <button type="button" id="tt-novel-rc-add-row" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 添加替换角色</button>
            </div>
            <div class="tt-novel-card-stack" id="tt-novel-rc-rows">${mappingsHtml}</div>
        </section>

        <section class="tt-novel-card">
            <div class="tt-novel-edit-grid">
                <label>额外世界观 / 背景微调要求（可选）
                    <textarea id="tt-novel-rc-extra" class="text_pole" rows="2" placeholder="例如：把原著的现代都市校园微调到罗德岛休假日常，其余叙事节奏与对话密度严格保留原著风格">${escapeHtml(recastDraftUi.extraRules || '')}</textarea>
                </label>
                <div class="tt-novel-action-bar">
                    <button type="button" id="tt-novel-rc-save" class="menu_button tt-novel-btn-sm tt-novel-btn-primary">保存换角配置</button>
                    <button type="button" id="tt-novel-rc-gen-outline" class="menu_button tt-novel-btn-sm" ${!hasNovel || task.running ? 'disabled' : ''}>生成第 ${curCursor} 章换角大纲</button>
                    <button type="button" id="tt-novel-rc-fill-write" class="menu_button tt-novel-btn-sm" ${!hasNovel ? 'disabled' : ''}>${uiIcon('send', 12)} 填入开写指令</button>
                </div>
            </div>
        </section>
    `;

    const syncRecastDraftFromDom = () => {
        const rows = [...bodyEl.querySelectorAll('#tt-novel-rc-rows [data-recast-row]')];
        const mappings = rows.map((row, idx) => {
            const id = row.getAttribute('data-recast-row') || `recast_${idx + 1}`;
            const read = (f) => String(row.querySelector(`[data-rc-field="${f}"]`)?.value || '').trim();
            return normalizeRecastMapping({
                id,
                fromName: read('fromName'),
                toName: read('toName'),
                toProfile: read('toProfile'),
                note: read('note'),
            }, idx);
        });
        recastDraftUi = {
            enabled: Boolean(bodyEl.querySelector('#tt-novel-rc-enabled')?.checked),
            sourceCursorChapter: Math.max(1, Number(bodyEl.querySelector('#tt-novel-rc-cursor')?.value || curCursor)),
            autoAdvanceCursor: Boolean(bodyEl.querySelector('#tt-novel-rc-auto-adv')?.checked),
            fidelity: String(bodyEl.querySelector('#tt-novel-rc-fidelity')?.value || 'balanced'),
            mappings: mappings.length > 0 ? mappings : [normalizeRecastMapping({}, 0)],
            extraRules: String(bodyEl.querySelector('#tt-novel-rc-extra')?.value || '').trim(),
        };
        return recastDraftUi;
    };

    const persistRecastConfig = async (showToast = true) => {
        const draft = syncRecastDraftFromDom();
        await handlers.onUpdateNarrativeConfig?.({ recast: normalizeRecastConfig(draft) });
        recastDraftUi = null;
        if (showToast) {
            globalThis.toastr?.success?.(
                draft.enabled
                    ? `已保存换角仿写配置（当前对照原著第 ${draft.sourceCursorChapter} 章）`
                    : '已保存换角仿写配置（当前未启用）',
                '小说工作台',
            );
        }
        return draft;
    };

    bodyEl.querySelector('[data-jump-lore]')?.addEventListener('click', () => {
        activeTab = 'memory';
        memoryFilter = 'canon';
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rc-prev')?.addEventListener('click', () => {
        syncRecastDraftFromDom();
        recastDraftUi.sourceCursorChapter = Math.max(1, recastDraftUi.sourceCursorChapter - 1);
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rc-next')?.addEventListener('click', () => {
        syncRecastDraftFromDom();
        recastDraftUi.sourceCursorChapter = Math.min(Math.max(1, totalCh), recastDraftUi.sourceCursorChapter + 1);
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rc-cursor')?.addEventListener('change', () => {
        syncRecastDraftFromDom();
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rc-add-row')?.addEventListener('click', () => {
        syncRecastDraftFromDom();
        recastDraftUi.mappings.push(normalizeRecastMapping({}, recastDraftUi.mappings.length));
        renderWorkbench();
    });
    bodyEl.querySelectorAll('[data-rc-action="del"]').forEach(btn => {
        btn.addEventListener('click', () => {
            syncRecastDraftFromDom();
            const id = btn.getAttribute('data-id');
            recastDraftUi.mappings = recastDraftUi.mappings.filter(m => m.id !== id);
            if (recastDraftUi.mappings.length === 0) {
                recastDraftUi.mappings.push(normalizeRecastMapping({}, 0));
            }
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-rc-action="lookup"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            syncRecastDraftFromDom();
            const id = btn.getAttribute('data-id');
            const target = recastDraftUi.mappings.find(m => m.id === id);
            const targetName = String(target?.toName || '').trim();
            if (!targetName) {
                globalThis.toastr?.warning?.('请先在右侧输入框填写要替换的新角色名（如 白金 / 塑心 / 椿）', '小说工作台');
                return;
            }
            const res = await handlers.onLookupLoreCharacter?.(targetName);
            if (!res?.summary) {
                globalThis.toastr?.warning?.(`未在已导入资料库中找到「${targetName}」，请先在「设定 → 设定库」导入并勾选对应同人资料库包`, '小说工作台');
                return;
            }
            target.toProfile = res.summary;
            renderWorkbench();
            globalThis.toastr?.success?.(`已从【${res.source}】自动填入「${res.title}」核心底骨档案`, '小说工作台');
        });
    });
    bodyEl.querySelector('#tt-novel-rc-save')?.addEventListener('click', async () => {
        await persistRecastConfig(true);
    });
    bodyEl.querySelector('#tt-novel-rc-gen-outline')?.addEventListener('click', async () => {
        const draft = syncRecastDraftFromDom();
        if (!draft.enabled) {
            draft.enabled = true;
        }
        await handlers.onUpdateNarrativeConfig?.({ recast: normalizeRecastConfig(draft) });
        recastDraftUi = null;
        createSubTab = 'scene';
        outlineDraftUiState.chapterCount = 1;
        renderWorkbench();
        handlers.onGenerateDirectorOutline?.({
            userBrief: outlineDraftUiState.userBrief || '',
            selectedHookIds: outlineDraftUiState.selectedHookIds || [],
            sceneCount: outlineDraftUiState.sceneCount,
            chapterCount: 1,
            paceMode: outlineDraftUiState.paceMode,
        });
    });
    bodyEl.querySelector('#tt-novel-rc-fill-write')?.addEventListener('click', async () => {
        const draft = syncRecastDraftFromDom();
        if (!draft.enabled) {
            draft.enabled = true;
        }
        await handlers.onUpdateNarrativeConfig?.({ recast: normalizeRecastConfig(draft) });
        recastDraftUi = null;
        const pairs = draft.mappings
            .filter(m => m.fromName || m.toName)
            .map(m => (m.fromName && m.toName ? `${m.fromName}→${m.toName}` : (m.toName || m.fromName)))
            .join('、');
        const promptText = `【逐章换角仿写 · 对照原著第 ${draft.sourceCursorChapter} 章${srcChapter?.title ? `《${srcChapter.title}》` : ''}】\n请严格按换角映射（${pairs || '已配置角色替换表'}）重塑本章正文：保留原著段长节奏、文风笔触与剧情骨架，但让新角色 100% 按其资料库真实性格、外貌着装与语感演出，严禁机械改名换皮或残留被替换原名。`;
        handlers.onApplyOutlineToChat?.(promptText, { autoSend: false });
    });
}

function renderSceneOutlineSubView(bodyEl, segHtml, progressHtml, ledger, bp, task) {
    const openHooks = (ledger.hooks || []).filter(h => h && h.status !== 'resolved');
    const savedDraft = ledger.draftOutline || null;
    const nextChIdx = Number(cachedAnchorInfo?.nextChapterIndex || 1);
    const activeVol = resolveActiveVolume(bp, nextChIdx);
    const nCfg = normalizeNarrativeConfig(ledger.narrativeConfig);

    if (outlineDraftUiState.selectedHookIds === null) {
        outlineDraftUiState.selectedHookIds = openHooks.filter(h => h.status === 'pinned').map(h => h.id);
    }
    const selectedHookSet = new Set(outlineDraftUiState.selectedHookIds);

    const anchorLabel = cachedAnchorInfo?.isRecastMode
        ? `换角仿写 · 对照原著 #${cachedAnchorInfo.recastSourceChapter?.index || nCfg.recast.sourceCursorChapter} → 写第 ${cachedAnchorInfo.nextChapterIndex} ${cachedAnchorInfo.chapterUnit}`
        : (cachedAnchorInfo?.isFreshStart
            ? `新书开篇 · 策划第 1 章`
            : (cachedAnchorInfo?.anchorTitle
                ? `承接「${cachedAnchorInfo.anchorTitle}」→ 第 ${cachedAnchorInfo.nextChapterIndex} ${cachedAnchorInfo.chapterUnit}`
                : '请先在「全书总纲」立项或导入原著'));

    const povTag = nCfg.povMode === 'strict_limited' && nCfg.povCharacter
        ? `单视角：${nCfg.povCharacter}`
        : '自动视角';

    const hookPickerHtml = openHooks.length === 0
        ? '<div class="tt-novel-muted">暂无待填伏笔，可在「设定 → 伏笔」添加。</div>'
        : `
            <div class="tt-novel-hook-picker">
                ${openHooks.map(h => {
                    const active = selectedHookSet.has(h.id);
                    const shortLabel = h.content.length > 30 ? `${h.content.slice(0, 30)}…` : h.content;
                    return `
                        <button type="button" class="tt-novel-filter-pill ${active ? 'active' : ''}" data-action="toggle-outline-hook" data-id="${escapeHtml(h.id)}" title="${escapeHtml(h.content)}">
                            #${Number(h.plantedChapter || 1)} ${escapeHtml(shortLabel)}
                        </button>
                    `;
                }).join('')}
            </div>
        `;

    const savedChapters = Array.isArray(savedDraft?.chapters) && savedDraft.chapters.length > 0
        ? savedDraft.chapters
        : (savedDraft?.outlineText
            ? [{
                id: 'outline_ch_legacy_1',
                chapterIndex: Number(savedDraft.targetChapterIndex || cachedAnchorInfo?.nextChapterIndex || 1),
                title: `第 ${Number(savedDraft.targetChapterIndex || cachedAnchorInfo?.nextChapterIndex || 1)} ${cachedAnchorInfo?.chapterUnit || '章'}`,
                text: savedDraft.outlineText,
                sent: false,
            }]
            : []);

    const chapterCardsHtml = savedChapters.length === 0
        ? '<div class="tt-novel-empty">还没有分章大纲。写一两句剧情想法后点「生成大纲」，或直接点「自动构思」。</div>'
        : savedChapters.map((ch, idx) => `
            <details class="tt-novel-card tt-novel-outline-card ${ch.sent ? 'is-sent' : ''}" data-outline-id="${escapeHtml(ch.id)}" ${(!ch.sent || savedChapters.length <= 2) ? 'open' : ''}>
                <summary class="tt-novel-card-head">
                    <div class="tt-novel-timeline-meta">
                        <span class="tt-novel-chip ${ch.sent ? 'is-ok' : 'is-gold'}">${ch.sent ? '已发' : `待写 #${idx + 1}`}</span>
                        <strong>${escapeHtml(ch.title || `第 ${ch.chapterIndex} 章`)}</strong>
                    </div>
                    <span class="tt-novel-muted">${String(ch.text || '').length} 字</span>
                </summary>
                <div class="tt-novel-outline-card-body">
                    <textarea class="text_pole tt-novel-style-editor" rows="7" data-outline-text="${escapeHtml(ch.id)}">${escapeHtml(ch.text || '')}</textarea>
                    <div class="tt-novel-action-bar">
                        <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="send-outline-ch" data-id="${escapeHtml(ch.id)}">
                            ${uiIcon('send', 12)} 开写此章
                        </button>
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="fill-outline-ch" data-id="${escapeHtml(ch.id)}">
                            ${uiIcon('copy', 12)} 填入
                        </button>
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="toggle-outline-sent" data-id="${escapeHtml(ch.id)}">
                            ${ch.sent ? '标为待写' : '标为已写'}
                        </button>
                        <div class="tt-novel-spacer"></div>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="move-outline-up" data-id="${escapeHtml(ch.id)}" title="上移" ${idx === 0 ? 'disabled' : ''}>${uiIcon('chevronUp', 13)}</button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="move-outline-down" data-id="${escapeHtml(ch.id)}" title="下移" ${idx === savedChapters.length - 1 ? 'disabled' : ''}>${uiIcon('chevronDown', 13)}</button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="del-outline-ch" data-id="${escapeHtml(ch.id)}" title="删除">${uiIcon('trash', 13)}</button>
                    </div>
                </div>
            </details>
        `).join('');

    bodyEl.innerHTML = `
        ${segHtml}
        <div class="tt-novel-context-strip">
            <span class="tt-novel-context-main">${escapeHtml(anchorLabel)}</span>
            <div class="tt-novel-context-links">
                ${activeVol ? `<button type="button" class="tt-novel-link-pill" data-jump-blueprint="1">第 ${activeVol.index} 卷</button>` : ''}
                <button type="button" class="tt-novel-link-pill" data-jump-narrative="1">${escapeHtml(povTag)}</button>
            </div>
        </div>
        ${progressHtml}

        <section class="tt-novel-card">
            <textarea id="tt-novel-outline-brief" class="text_pole" rows="3" placeholder="输入接下来想写的剧情走向、冲突或结果（留空可直接点「自动构思」）...">${escapeHtml(outlineDraftUiState.userBrief || '')}</textarea>
            <div class="tt-novel-action-bar">
                <select id="tt-novel-outline-chapters" class="text_pole tt-novel-compact-select" aria-label="规划章数">
                    <option value="1" ${Number(outlineDraftUiState.chapterCount) === 1 ? 'selected' : ''}>1 章</option>
                    <option value="2" ${Number(outlineDraftUiState.chapterCount) === 2 ? 'selected' : ''}>2 章</option>
                    <option value="3" ${Number(outlineDraftUiState.chapterCount || 3) === 3 ? 'selected' : ''}>3 章</option>
                    <option value="5" ${Number(outlineDraftUiState.chapterCount) === 5 ? 'selected' : ''}>5 章</option>
                    <option value="8" ${Number(outlineDraftUiState.chapterCount) === 8 ? 'selected' : ''}>8 章</option>
                </select>
                <button type="button" id="tt-novel-outline-generate" class="menu_button tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                    生成大纲
                </button>
                <button type="button" id="tt-novel-outline-auto" class="menu_button" ${task.running ? 'disabled' : ''}>
                    自动构思
                </button>
            </div>
            <details class="tt-novel-subtle-fold">
                <summary>高级参数与伏笔（${outlineDraftUiState.sceneCount} 镜头 · 已选 ${selectedHookSet.size}/${openHooks.length} 伏笔）</summary>
                <div class="tt-novel-edit-grid" style="margin-top: 8px;">
                    <div class="tt-novel-row-2">
                        <label>每章切镜数
                            <select id="tt-novel-outline-scenes" class="text_pole">
                                <option value="3" ${Number(outlineDraftUiState.sceneCount) === 3 ? 'selected' : ''}>3 镜头（紧凑）</option>
                                <option value="4" ${Number(outlineDraftUiState.sceneCount || 4) === 4 ? 'selected' : ''}>4 镜头（标准）</option>
                                <option value="5" ${Number(outlineDraftUiState.sceneCount) === 5 ? 'selected' : ''}>5 镜头（多线）</option>
                            </select>
                        </label>
                        <label>推进步幅
                            <select id="tt-novel-outline-pace" class="text_pole">
                                <option value="slow" ${outlineDraftUiState.paceMode === 'slow' ? 'selected' : ''}>稳步铺垫</option>
                                <option value="medium" ${outlineDraftUiState.paceMode === 'medium' ? 'selected' : ''}>中速推进</option>
                                <option value="climax" ${outlineDraftUiState.paceMode === 'climax' ? 'selected' : ''}>高潮回收</option>
                            </select>
                        </label>
                    </div>
                    <div>
                        <div class="tt-novel-field-label">本次推进的伏笔</div>
                        ${hookPickerHtml}
                    </div>
                </div>
            </details>
        </section>

        <section class="tt-novel-section">
            <div class="tt-novel-card-head">
                <div class="tt-novel-section-title">分章大纲队列（${savedChapters.length}）</div>
                <div class="tt-novel-card-actions">
                    <button type="button" id="tt-novel-outline-add-ch" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 新增</button>
                    ${savedChapters.length > 0 ? '<button type="button" id="tt-novel-outline-save-all" class="menu_button tt-novel-btn-sm">保存修改</button>' : ''}
                </div>
            </div>
            <div class="tt-novel-card-stack">${chapterCardsHtml}</div>
        </section>
    `;

    bodyEl.querySelector('[data-jump-blueprint]')?.addEventListener('click', () => {
        createSubTab = 'blueprint';
        renderWorkbench();
    });
    bodyEl.querySelector('[data-jump-narrative]')?.addEventListener('click', () => {
        void openWorkbench('settings', { settingsSection: 'narrative' });
    });

    const briefEl = bodyEl.querySelector('#tt-novel-outline-brief');
    const chaptersEl = bodyEl.querySelector('#tt-novel-outline-chapters');
    const scenesEl = bodyEl.querySelector('#tt-novel-outline-scenes');
    const paceEl = bodyEl.querySelector('#tt-novel-outline-pace');

    briefEl?.addEventListener('input', (e) => {
        outlineDraftUiState.userBrief = String(e.target.value || '');
    });
    chaptersEl?.addEventListener('change', (e) => {
        outlineDraftUiState.chapterCount = Math.max(1, Math.min(8, Number(e.target.value) || 3));
        renderWorkbench();
    });
    scenesEl?.addEventListener('change', (e) => {
        outlineDraftUiState.sceneCount = Math.max(2, Math.min(6, Number(e.target.value) || 4));
    });
    paceEl?.addEventListener('change', (e) => {
        outlineDraftUiState.paceMode = String(e.target.value || 'slow');
    });

    bodyEl.querySelectorAll('[data-action="toggle-outline-hook"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            if (!id) return;
            const curSet = new Set(outlineDraftUiState.selectedHookIds || []);
            if (curSet.has(id)) curSet.delete(id);
            else curSet.add(id);
            outlineDraftUiState.selectedHookIds = [...curSet];
            renderWorkbench();
        });
    });

    bodyEl.querySelector('#tt-novel-outline-generate')?.addEventListener('click', () => {
        const brief = String(briefEl?.value || '').trim();
        outlineDraftUiState.userBrief = brief;
        handlers.onGenerateDirectorOutline?.({
            userBrief: brief,
            selectedHookIds: outlineDraftUiState.selectedHookIds || [],
            sceneCount: outlineDraftUiState.sceneCount,
            chapterCount: outlineDraftUiState.chapterCount,
            paceMode: outlineDraftUiState.paceMode,
        });
    });

    bodyEl.querySelector('#tt-novel-outline-auto')?.addEventListener('click', () => {
        handlers.onGenerateDirectorOutline?.({
            userBrief: '',
            selectedHookIds: outlineDraftUiState.selectedHookIds || [],
            sceneCount: outlineDraftUiState.sceneCount,
            chapterCount: outlineDraftUiState.chapterCount,
            paceMode: outlineDraftUiState.paceMode,
        });
    });

    const collectEditedChapters = () => savedChapters.map(ch => {
        const ta = bodyEl.querySelector(`textarea[data-outline-text="${CSS.escape(ch.id)}"]`);
        return {
            ...ch,
            text: ta ? String(ta.value || '').trim() : ch.text,
        };
    });

    const persistDraftChapters = async (updatedChapters) => {
        const cur = await loadLedger();
        cur.draftOutline = {
            ...(cur.draftOutline || {}),
            userBrief: String(briefEl?.value || '').trim(),
            chapters: updatedChapters,
            outlineText: updatedChapters.map(c => c.text).join('\n\n---\n\n'),
            chapterCount: outlineDraftUiState.chapterCount,
            sceneCount: outlineDraftUiState.sceneCount,
            paceMode: outlineDraftUiState.paceMode,
            selectedHookIds: [...(outlineDraftUiState.selectedHookIds || [])],
            updatedAt: Date.now(),
        };
        await saveLedger(cur);
        cachedLedger = cur;
    };

    bodyEl.querySelector('#tt-novel-outline-save-all')?.addEventListener('click', async () => {
        await persistDraftChapters(collectEditedChapters());
        globalThis.toastr?.success?.('已保存章节大纲修改', '小说工作台');
    });

    bodyEl.querySelectorAll('[data-action="fill-outline-ch"], [data-action="send-outline-ch"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const autoSend = btn.getAttribute('data-action') === 'send-outline-ch';
            const edited = collectEditedChapters();
            const target = edited.find(c => c.id === id);
            if (!target || !target.text) {
                globalThis.toastr?.warning?.('该章大纲为空', '小说工作台');
                return;
            }
            target.sent = true;
            await persistDraftChapters(edited);
            handlers.onApplyOutlineToChat?.(target.text, { autoSend });
        });
    });

    bodyEl.querySelectorAll('[data-action="toggle-outline-sent"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const edited = collectEditedChapters();
            const target = edited.find(c => c.id === id);
            if (target) {
                target.sent = !target.sent;
                await persistDraftChapters(edited);
                renderWorkbench();
            }
        });
    });

    bodyEl.querySelector('#tt-novel-outline-add-ch')?.addEventListener('click', async () => {
        const edited = collectEditedChapters();
        const maxIdx = edited.reduce((m, c) => Math.max(m, Number(c.chapterIndex || 0)), Number(cachedAnchorInfo?.prevChapterIndex || 0));
        const nextIdx = maxIdx + 1;
        const unit = cachedAnchorInfo?.chapterUnit || '章';
        const title = window.prompt('请输入新增大纲章节标题（可留空）：', `第 ${nextIdx} ${unit}`);
        if (title === null) return;
        edited.push({
            id: `outline_ch_manual_${Date.now()}`,
            chapterIndex: nextIdx,
            title: title.trim() || `第 ${nextIdx} ${unit}`,
            text: `【${title.trim() || `第 ${nextIdx} ${unit}`} 分镜大纲】\n1. `,
            sent: false,
        });
        await persistDraftChapters(edited);
        renderWorkbench();
    });

    bodyEl.querySelectorAll('[data-action="move-outline-up"], [data-action="move-outline-down"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const dir = btn.getAttribute('data-action') === 'move-outline-up' ? -1 : 1;
            const edited = collectEditedChapters();
            const pos = edited.findIndex(c => c.id === id);
            const swap = pos + dir;
            if (pos < 0 || swap < 0 || swap >= edited.length) return;
            [edited[pos], edited[swap]] = [edited[swap], edited[pos]];
            await persistDraftChapters(edited);
            renderWorkbench();
        });
    });

    bodyEl.querySelectorAll('[data-action="del-outline-ch"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const edited = collectEditedChapters().filter(c => c.id !== id);
            await persistDraftChapters(edited);
            renderWorkbench();
        });
    });
}

function renderBlueprintSubView(bodyEl, segHtml, progressHtml, ledger, bp, task) {
    const hasOrigNovel = Boolean(cachedNovelData?.chapters?.length);
    const hasBp = hasStoryBlueprintData(bp);

    const volumesHtml = bp.volumes.length === 0
        ? '<div class="tt-novel-empty">尚未建立分卷路线图。在上方填写脑洞或设定稿后点「生成总纲与分卷」，或点右侧「新增一卷」。</div>'
        : bp.volumes.map((v) => {
            const isAct = v.status === 'active';
            const isDone = v.status === 'completed';
            const badgeCls = isAct ? 'is-gold' : (isDone ? 'is-ok' : '');
            const badgeLabel = isAct ? '连载中' : (isDone ? '已完结' : '规划中');
            return `
                <details class="tt-novel-card tt-novel-outline-card ${isDone ? 'is-sent' : ''}" data-vol-id="${escapeHtml(v.id)}" ${isAct ? 'open' : ''}>
                    <summary class="tt-novel-card-head">
                        <div class="tt-novel-timeline-meta">
                            <span class="tt-novel-chip ${badgeCls}">${badgeLabel}</span>
                            <strong>第 ${v.index} 卷 · ${escapeHtml(v.title)}</strong>
                            <span class="tt-novel-muted">${escapeHtml(v.chapterRange)}</span>
                        </div>
                        <span class="tt-novel-muted">${v.recap ? '已复盘' : ''}</span>
                    </summary>
                    <div class="tt-novel-edit-grid" style="margin-top: 8px;">
                        <div class="tt-novel-row-2">
                            <input type="text" class="text_pole" data-vol-field="title" value="${escapeHtml(v.title)}" placeholder="卷名" />
                            <input type="text" class="text_pole" data-vol-field="chapterRange" value="${escapeHtml(v.chapterRange)}" placeholder="章号范围（如 第 1~15 章）" />
                        </div>
                        <textarea class="text_pole" rows="2" data-vol-field="goal" placeholder="本卷目标、舞台背景与核心矛盾">${escapeHtml(v.goal || '')}</textarea>
                        <textarea class="text_pole" rows="2" data-vol-field="keyTurns" placeholder="关键转折与卷末高潮">${escapeHtml(v.keyTurns || '')}</textarea>
                        <input type="text" class="text_pole" data-vol-field="endingHook" value="${escapeHtml(v.endingHook || '')}" placeholder="引向下一卷的悬念钩子" />
                        ${v.recap ? `
                            <div class="tt-novel-diff-box is-cool">
                                <div class="tt-novel-mini-label">本卷复盘（自动供后续分卷继承）</div>
                                <textarea class="text_pole" rows="3" data-vol-field="recap">${escapeHtml(v.recap)}</textarea>
                            </div>
                        ` : ''}
                        ${v.recapCheck ? `
                            <details class="tt-novel-subfold">
                                <summary>查看卷纲偏离审计报告</summary>
                                <div class="tt-novel-pre-wrap">${escapeHtml(v.recapCheck)}</div>
                            </details>
                        ` : ''}
                        <div class="tt-novel-action-bar">
                            ${!isAct ? `<button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-vol-action="set-active" data-vol-id="${escapeHtml(v.id)}">设为当前卷</button>` : ''}
                            <button type="button" class="menu_button tt-novel-btn-sm" data-vol-action="toggle-done" data-vol-id="${escapeHtml(v.id)}">${isDone ? '恢复规划' : '标为完结'}</button>
                            <button type="button" class="menu_button tt-novel-btn-sm" data-vol-action="gen-recap" data-vol-id="${escapeHtml(v.id)}" ${task.running ? 'disabled' : ''}>卷末复盘</button>
                            <div class="tt-novel-spacer"></div>
                            <button type="button" class="tt-novel-mini-icon-btn" data-vol-action="del-vol" data-vol-id="${escapeHtml(v.id)}" title="删除此卷">${uiIcon('trash', 13)}</button>
                        </div>
                    </div>
                </details>
            `;
        }).join('');

    bodyEl.innerHTML = `
        ${segHtml}
        ${progressHtml}

        <section class="tt-novel-card">
            <div class="tt-novel-section-title">作品立项与起手素材</div>
            <div class="tt-novel-edit-grid">
                <div class="tt-novel-row-3">
                    <label>书名
                        <input type="text" id="tt-novel-bp-title" class="text_pole" value="${escapeHtml(bp.title || cachedNovelData?.title || '')}" placeholder="可留空由 AI 起名" />
                    </label>
                    <label>模式
                        <select id="tt-novel-bp-mode" class="text_pole">
                            <option value="original" ${bp.creationMode === 'original' || (!hasOrigNovel && bp.creationMode === 'continuation') ? 'selected' : ''}>原创世界观</option>
                            <option value="fanfic_new" ${bp.creationMode === 'fanfic_new' ? 'selected' : ''}>同人新开坑</option>
                            <option value="continuation" ${hasOrigNovel && bp.creationMode === 'continuation' ? 'selected' : ''}>原著续写规划</option>
                        </select>
                    </label>
                    <label>题材基调
                        <input type="text" id="tt-novel-bp-genre" class="text_pole" value="${escapeHtml(bp.genreAndTone || '')}" placeholder="如：冷峻悬疑 / 权谋" />
                    </label>
                </div>
                <label>脑洞或完整设定草稿（自动联动酒馆世界书）
                    <textarea id="tt-novel-bp-seed" class="text_pole" rows="4" placeholder="可写几句话脑洞，也可直接粘贴大段世界观、主角与势力草稿...">${escapeHtml(bp.seedNotes || '')}</textarea>
                </label>
                <div class="tt-novel-action-bar">
                    <select id="tt-novel-bp-volcount" class="text_pole tt-novel-compact-select" aria-label="规划总卷数">
                        ${[2, 3, 4, 5, 6].map(n => `<option value="${n}" ${Number(outlineDraftUiState.blueprintVolumeCount || 4) === n ? 'selected' : ''}>${n} 卷</option>`).join('')}
                    </select>
                    <select id="tt-novel-bp-chpervol" class="text_pole tt-novel-compact-select" aria-label="每卷预计章数">
                        ${[10, 15, 20, 30].map(n => `<option value="${n}" ${Number(outlineDraftUiState.blueprintChaptersPerVol || 15) === n ? 'selected' : ''}>约 ${n} 章/卷</option>`).join('')}
                    </select>
                    <button type="button" id="tt-novel-bp-generate" class="menu_button tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                        生成总纲与分卷
                    </button>
                    <button type="button" id="tt-novel-bp-save" class="menu_button">保存</button>
                </div>
            </div>
        </section>

        <details class="tt-novel-accordion" ${hasBp ? 'open' : ''}>
            <summary>
                <span>L1 全书总纲与铁律</span>
                <span class="tt-novel-muted">${bp.premise ? `${bp.premise.length} 字` : '未填写'}</span>
            </summary>
            <div class="tt-novel-accordion-body">
                <div class="tt-novel-edit-grid">
                    <label>全书总纲（核心主线、主角弧线与冲突脉络）
                        <textarea id="tt-novel-bp-premise" class="text_pole" rows="3" placeholder="AI 生成后或手动编辑...">${escapeHtml(bp.premise || '')}</textarea>
                    </label>
                    <div class="tt-novel-row-2">
                        <label>世界规则与创作红线
                            <textarea id="tt-novel-bp-rules" class="text_pole" rows="2" placeholder="力量/社会规则与逻辑底线...">${escapeHtml(bp.worldRules || '')}</textarea>
                        </label>
                        <label>终局方向
                            <textarea id="tt-novel-bp-ending" class="text_pole" rows="2" placeholder="最终高潮与收束方向...">${escapeHtml(bp.endingDirection || '')}</textarea>
                        </label>
                    </div>
                </div>
            </div>
        </details>

        <section class="tt-novel-section">
            <div class="tt-novel-card-head">
                <div class="tt-novel-section-title">L2 分卷路线图（${bp.volumes.length}）</div>
                <button type="button" id="tt-novel-bp-add-vol" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 新增一卷</button>
            </div>
            <div class="tt-novel-card-stack" id="tt-novel-bp-volumes">${volumesHtml}</div>
        </section>
    `;

    const collectBlueprintFromDom = () => {
        const volCards = [...bodyEl.querySelectorAll('#tt-novel-bp-volumes [data-vol-id]')];
        const byId = new Map((bp.volumes || []).map(v => [v.id, v]));
        const volumes = volCards.map((card, i) => {
            const id = card.getAttribute('data-vol-id');
            const prev = byId.get(id) || {};
            const readF = (f) => {
                const el = card.querySelector(`[data-vol-field="${f}"]`);
                return el ? String(el.value || '').trim() : (prev[f] || '');
            };
            const rangeVal = readF('chapterRange');
            const nums = [...rangeVal.matchAll(/\d+/g)].map(m => Number(m[0])).filter(n => n > 0);
            return normalizeStoryVolume({
                ...prev,
                id,
                index: i + 1,
                title: readF('title') || prev.title,
                chapterRange: rangeVal || prev.chapterRange,
                startChapter: nums[0] || prev.startChapter,
                endChapter: nums[nums.length - 1] || prev.endChapter,
                goal: readF('goal'),
                keyTurns: readF('keyTurns'),
                endingHook: readF('endingHook'),
                recap: readF('recap'),
            }, i + 1);
        });
        return normalizeStoryBlueprint({
            creationMode: String(bodyEl.querySelector('#tt-novel-bp-mode')?.value || bp.creationMode || 'original'),
            title: String(bodyEl.querySelector('#tt-novel-bp-title')?.value || '').trim(),
            genreAndTone: String(bodyEl.querySelector('#tt-novel-bp-genre')?.value || '').trim(),
            seedNotes: String(bodyEl.querySelector('#tt-novel-bp-seed')?.value || '').trim(),
            premise: String(bodyEl.querySelector('#tt-novel-bp-premise')?.value || '').trim(),
            worldRules: String(bodyEl.querySelector('#tt-novel-bp-rules')?.value || '').trim(),
            endingDirection: String(bodyEl.querySelector('#tt-novel-bp-ending')?.value || '').trim(),
            volumes,
        });
    };

    bodyEl.querySelector('#tt-novel-bp-volcount')?.addEventListener('change', (e) => {
        outlineDraftUiState.blueprintVolumeCount = Math.max(2, Math.min(8, Number(e.target.value) || 4));
    });
    bodyEl.querySelector('#tt-novel-bp-chpervol')?.addEventListener('change', (e) => {
        outlineDraftUiState.blueprintChaptersPerVol = Math.max(5, Math.min(50, Number(e.target.value) || 15));
    });
    bodyEl.querySelector('#tt-novel-bp-save')?.addEventListener('click', async () => {
        await handlers.onSaveStoryBlueprint?.(collectBlueprintFromDom());
        globalThis.toastr?.success?.('已保存总纲与分卷路线图', '小说工作台');
    });
    bodyEl.querySelector('#tt-novel-bp-generate')?.addEventListener('click', async () => {
        const draftBp = collectBlueprintFromDom();
        await handlers.onSaveStoryBlueprint?.(draftBp);
        await handlers.onGenerateMasterBlueprint?.({
            title: draftBp.title,
            creationMode: draftBp.creationMode,
            genreAndTone: draftBp.genreAndTone,
            seedNotes: draftBp.seedNotes,
            volumeCount: outlineDraftUiState.blueprintVolumeCount,
            chaptersPerVolume: outlineDraftUiState.blueprintChaptersPerVol,
        });
    });
    bodyEl.querySelector('#tt-novel-bp-add-vol')?.addEventListener('click', async () => {
        const draftBp = collectBlueprintFromDom();
        const nextIdx = draftBp.volumes.length + 1;
        const lastEnd = draftBp.volumes.length > 0 ? Number(draftBp.volumes[draftBp.volumes.length - 1].endChapter || 0) : 0;
        const step = Number(outlineDraftUiState.blueprintChaptersPerVol || 15);
        draftBp.volumes.push(normalizeStoryVolume({
            index: nextIdx,
            title: `新篇章 ${nextIdx}`,
            startChapter: lastEnd + 1,
            endChapter: lastEnd + step,
            chapterRange: `第 ${lastEnd + 1}~${lastEnd + step} 章`,
            status: nextIdx === 1 ? 'active' : 'planned',
        }, nextIdx));
        await handlers.onSaveStoryBlueprint?.(draftBp);
    });
    bodyEl.querySelectorAll('[data-vol-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.getAttribute('data-vol-action');
            const volId = btn.getAttribute('data-vol-id');
            const draftBp = collectBlueprintFromDom();
            if (action === 'set-active') {
                for (const v of draftBp.volumes) {
                    if (v.id === volId) v.status = 'active';
                    else if (v.status === 'active') v.status = 'planned';
                }
                await handlers.onSaveStoryBlueprint?.(draftBp);
            } else if (action === 'toggle-done') {
                const target = draftBp.volumes.find(v => v.id === volId);
                if (target) target.status = target.status === 'completed' ? 'planned' : 'completed';
                await handlers.onSaveStoryBlueprint?.(draftBp);
            } else if (action === 'del-vol') {
                draftBp.volumes = draftBp.volumes.filter(v => v.id !== volId).map((v, i) => ({ ...v, index: i + 1 }));
                await handlers.onSaveStoryBlueprint?.(draftBp);
            } else if (action === 'gen-recap') {
                await handlers.onSaveStoryBlueprint?.(draftBp);
                await handlers.onGenerateVolumeRecap?.(volId);
            }
        });
    });
}

/* ==========================================================================
   TAB 2: 设定 (Focused Single-Category Views: 人物 / 编年史 / 伏笔 / 状态 / 设定库)
   ========================================================================== */
function renderMemoryTab(bodyEl) {
    const ledger = cachedLedger || { chronicle: [], characters: [], hooks: [], worldStates: [], summaries: [], archiveBatches: [] };
    const canonDb = cachedCanonDb || { sources: [], items: [] };
    const nCfg = normalizeNarrativeConfig(ledger.narrativeConfig);
    const chars = ledger.characters || [];
    const chronicle = ledger.chronicle || [];
    const hooks = ledger.hooks || [];
    const worldStates = ledger.worldStates || [];
    const summaries = ledger.summaries || [];
    const canonItems = canonDb.items || [];
    const batches = ledger.archiveBatches || [];
    const failedBatches = batches.filter(b => b.status !== 'ok');
    const okBatchCount = batches.length - failedBatches.length;
    const openHooks = hooks.filter(h => h.status !== 'resolved');
    const resolvedHooks = hooks.filter(h => h.status === 'resolved');
    const task = liveTaskState.memory;
    const processLogs = task.running && task.logs.length > 0 ? task.logs : (ledger.archiveProcessLog || []);

    if (!['chars', 'chronicle', 'hooks', 'world', 'canon'].includes(memoryFilter)) {
        memoryFilter = 'chars';
    }

    const latestWrittenCh = Number(cachedAnchorInfo?.prevChapterIndex || cachedNovelData?.cutoffChapterIndex || 0);
    const archivedTo = Number(ledger.lastArchivedChapter || 0);
    const unarchivedGap = latestWrittenCh > archivedTo ? (latestWrittenCh - archivedTo) : 0;
    const missingSumCount = Number(cachedAnchorInfo?.missingSummaryCount || 0);

    // Choose ONE contextual primary maintenance button
    let primaryActionId = 'tt-novel-run-archive-full';
    let primaryActionLabel = '全本归档';
    if (missingSumCount > 0) {
        primaryActionId = 'tt-novel-backfill-sums';
        primaryActionLabel = `补齐总结 (+${missingSumCount})`;
    } else if (archivedTo > 0 && unarchivedGap >= 2) {
        primaryActionId = 'tt-novel-run-archive-inc';
        primaryActionLabel = `增量归档 (+${unarchivedGap})`;
    }

    const povChipText = nCfg.povMode === 'strict_limited' && nCfg.povCharacter
        ? `单视角：${nCfg.povCharacter}`
        : '自动视角';

    const progressHtml = renderTaskProgressBanner('memory', task);

    const failedRangeText = failedBatches.map(b => `第${b.startChapter}~${b.endChapter}章`).join('、');
    const sliceManagerHtml = batches.length > 0
        ? `
        <details class="tt-novel-accordion" ${(failedBatches.length > 0 || ledger.archiveNeedsResynth) ? 'open' : ''}>
            <summary>
                <span>分批切片管理</span>
                <span class="tt-novel-muted">${okBatchCount}/${batches.length} 正常${failedBatches.length > 0 ? ` · ${failedBatches.length} 异常` : ''}</span>
            </summary>
            <div class="tt-novel-accordion-body">
                ${failedBatches.length > 0 ? `<div class="tt-novel-banner is-warn">${statusDot('warn')} 异常切片：<b>${escapeHtml(failedRangeText)}</b>，可单独重跑后再合稿。</div>` : ''}
                ${ledger.archiveNeedsResynth ? `<div class="tt-novel-banner is-running">${statusDot('running')} 切片已更新，请点击「重新合稿总账」。</div>` : ''}
                <div class="tt-novel-action-bar">
                    ${failedBatches.length > 0 ? `<button type="button" id="tt-novel-rerun-failed-slices" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>重跑异常切片 (${failedBatches.length})</button>` : ''}
                    <button type="button" id="tt-novel-resynth-slices" class="menu_button tt-novel-btn-sm ${(ledger.archiveNeedsResynth || chars.length === 0) ? 'tt-novel-btn-primary' : ''}" ${task.running || okBatchCount === 0 ? 'disabled' : ''}>重新合稿总账</button>
                </div>
                <div class="tt-novel-slice-list">
                    ${batches.map(b => {
                        const isOk = b.status === 'ok';
                        const isRefused = b.status === 'refused';
                        const chipClass = isOk ? 'is-ok' : 'is-danger';
                        const statusText = isOk ? '正常' : (isRefused ? '疑似拒答' : '异常');
                        return `
                            <div class="tt-novel-slice-row ${isOk ? '' : 'is-bad'}">
                                <div class="tt-novel-slice-head">
                                    <div class="tt-novel-slice-info">
                                        <span class="tt-novel-chip ${chipClass}">${statusText}</span>
                                        <strong>#${b.batchIndex} 第 ${b.startChapter}~${b.endChapter} 章</strong>
                                        <span class="tt-novel-muted">${b.charCount ? `${b.charCount}字` : ''}</span>
                                    </div>
                                    <button type="button" class="menu_button tt-novel-btn-sm" data-action="rerun-slice" data-batch="${b.batchIndex}" ${task.running ? 'disabled' : ''}>${uiIcon('refresh', 12)} 重跑</button>
                                </div>
                                <details class="tt-novel-slice-detail">
                                    <summary class="tt-novel-muted">${escapeHtml(b.statusNote || '查看切片笔记')}</summary>
                                    <pre class="tt-novel-pre">${escapeHtml(b.notes || b.statusNote || '（空）')}</pre>
                                </details>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        </details>`
        : '';

    const logHtml = processLogs.length > 0
        ? `
        <details class="tt-novel-subtle-fold" ${task.running ? 'open' : ''}>
            <summary>归档运行日志（${processLogs.length}）</summary>
            <div class="tt-novel-log-list">
                ${processLogs.map(item => `
                    <details class="tt-novel-step-item">
                        <summary><strong>${escapeHtml(item.title || '')}</strong> <span class="tt-novel-muted">${escapeHtml(item.summary || '')}</span></summary>
                        <pre class="tt-novel-pre">${escapeHtml(item.detail || '')}</pre>
                    </details>
                `).join('')}
            </div>
        </details>`
        : '';

    let activeSectionHtml = '';

    if (memoryFilter === 'chars') {
        const charCardsHtml = chars.length === 0
            ? '<div class="tt-novel-empty">暂无人物档案。可点右上角「新增」手动建立主角卡片，或在「创作 → 全书总纲」生成。</div>'
            : chars.map(ch => {
                if (editingCharacterId === ch.id) {
                    return `
                        <div class="tt-novel-card tt-novel-char-card is-editing" data-char-id="${escapeHtml(ch.id)}">
                            <div class="tt-novel-edit-grid">
                                <div class="tt-novel-row-2">
                                    <input type="text" class="text_pole" data-field="name" value="${escapeHtml(ch.name)}" placeholder="人物姓名" />
                                    <input type="text" class="text_pole" data-field="role" value="${escapeHtml(ch.role || '')}" placeholder="身份定位" />
                                </div>
                                <label>当前外观与着装锚点<textarea class="text_pole" rows="2" data-field="currentAppearance" placeholder="发色、瞳色、日常服装与标志物件...">${escapeHtml(ch.currentAppearance || '')}</textarea></label>
                                <label>设定底骨与能力<textarea class="text_pole" rows="2" data-field="canonFoundation" placeholder="出身背景、性格底色、能力体系与上限...">${escapeHtml(ch.canonFoundation || '')}</textarea></label>
                                <label>当前处境与关系<textarea class="text_pole" rows="2" data-field="currentSituation">${escapeHtml(ch.currentSituation || '')}</textarea></label>
                                <label>言行风格与原话范本<textarea class="text_pole" rows="2" data-field="voiceAndQuotes" placeholder="说话腔调、口头禅及 2~3 句代表台词...">${escapeHtml(ch.voiceAndQuotes || '')}</textarea></label>
                                <label>绝对 OOC 红线<textarea class="text_pole" rows="2" data-field="oocRedLines" placeholder="绝不会做的行为与底线...">${escapeHtml(ch.oocRedLines || '')}</textarea></label>
                            </div>
                            <div class="tt-novel-card-actions">
                                <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="save-char" data-id="${escapeHtml(ch.id)}">保存</button>
                                <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-char">取消</button>
                            </div>
                        </div>
                    `;
                }
                return `
                    <div class="tt-novel-card tt-novel-char-card">
                        <div class="tt-novel-card-head">
                            <div>
                                <strong class="tt-novel-char-name">${escapeHtml(ch.name)}</strong>
                                ${ch.role ? `<span class="tt-novel-chip">${escapeHtml(ch.role)}</span>` : ''}
                            </div>
                            <div class="tt-novel-card-actions">
                                <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-char" data-id="${escapeHtml(ch.id)}" title="编辑">${uiIcon('edit', 13)}</button>
                                <button type="button" class="tt-novel-mini-icon-btn" data-action="del-char" data-id="${escapeHtml(ch.id)}" title="删除">${uiIcon('trash', 13)}</button>
                            </div>
                        </div>
                        ${ch.currentAppearance ? `<div class="tt-novel-char-row is-appear"><span>外观着装</span><p>${escapeHtml(ch.currentAppearance)}</p></div>` : ''}
                        ${ch.canonFoundation ? `<div class="tt-novel-char-row is-canon"><span>设定底骨</span><p>${escapeHtml(ch.canonFoundation)}</p></div>` : ''}
                        ${ch.currentSituation ? `<div class="tt-novel-char-row is-sit"><span>当前处境</span><p>${escapeHtml(ch.currentSituation)}</p></div>` : ''}
                        ${ch.voiceAndQuotes ? `<div class="tt-novel-char-row is-voice"><span>言行范本</span><p>${escapeHtml(ch.voiceAndQuotes)}</p></div>` : ''}
                        ${ch.oocRedLines ? `<div class="tt-novel-char-row is-ooc"><span>OOC 红线</span><p>${escapeHtml(ch.oocRedLines)}</p></div>` : ''}
                    </div>
                `;
            }).join('');

        activeSectionHtml = `
            <section class="tt-novel-section">
                <div class="tt-novel-card-head">
                    <div class="tt-novel-section-title">核心人物档案 <span class="tt-novel-muted">（已归档至第 ${archivedTo} 章）</span></div>
                    <button type="button" id="tt-novel-add-char" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 新增人物</button>
                </div>
                <div class="tt-novel-card-grid">${charCardsHtml}</div>
            </section>
        `;
    } else if (memoryFilter === 'chronicle') {
        const chronicleHtml = chronicle.length === 0
            ? '<div class="tt-novel-empty">暂无剧情编年史。写作若干章后可点顶部归档自动汇总，或手动新增。</div>'
            : chronicle.map(evt => {
                if (editingEventId === evt.id) {
                    return `
                        <div class="tt-novel-card is-editing" data-evt-id="${escapeHtml(evt.id)}">
                            <div class="tt-novel-edit-grid">
                                <div class="tt-novel-row-3">
                                    <input type="text" class="text_pole" data-field="chapterRange" value="${escapeHtml(evt.chapterRange || '')}" placeholder="章号如 #1-#7" />
                                    <input type="text" class="text_pole" data-field="timeLabel" value="${escapeHtml(evt.timeLabel || '')}" placeholder="时间阶段" />
                                    <select class="text_pole" data-field="timelinePhase">
                                        <option value="main" ${evt.timelinePhase !== 'flashback' && evt.timelinePhase !== 'reference' ? 'selected' : ''}>主线推进</option>
                                        <option value="reference" ${evt.timelinePhase === 'reference' ? 'selected' : ''}>基准时间线</option>
                                        <option value="flashback" ${evt.timelinePhase === 'flashback' ? 'selected' : ''}>倒叙/插叙</option>
                                    </select>
                                </div>
                                <div class="tt-novel-row-2">
                                    <input type="text" class="text_pole" data-field="title" value="${escapeHtml(evt.title || '')}" placeholder="事件标题" />
                                    <input type="text" class="text_pole" data-field="pov" value="${escapeHtml(evt.pov || '')}" placeholder="叙事视角" />
                                </div>
                                <input type="text" class="text_pole" data-field="participants" value="${escapeHtml((evt.participants || []).join('、'))}" placeholder="出场人物（顿号分隔）" />
                                <textarea class="text_pole" rows="3" data-field="summary" placeholder="客观剧情经过与结果">${escapeHtml(evt.summary || '')}</textarea>
                                <input type="text" class="text_pole" data-field="infoGap" value="${escapeHtml(evt.infoGap || '')}" placeholder="通用信息差" />
                                <input type="text" class="text_pole" data-field="povKnown" value="${escapeHtml(evt.povKnown || '')}" placeholder="主视角已知事实" />
                                <input type="text" class="text_pole" data-field="povBlindspot" value="${escapeHtml(evt.povBlindspot || '')}" placeholder="主视角盲区/黑盒" />
                            </div>
                            <div class="tt-novel-card-actions">
                                <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="save-evt" data-id="${escapeHtml(evt.id)}">保存</button>
                                <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-evt">取消</button>
                            </div>
                        </div>
                    `;
                }
                return `
                    <div class="tt-novel-card tt-novel-timeline-card">
                        <div class="tt-novel-card-head">
                            <div class="tt-novel-timeline-meta">
                                <span class="tt-novel-chip is-gold">${escapeHtml(evt.chapterRange || `#${evt.startChapter || 1}`)}</span>
                                ${evt.timelinePhase === 'reference' ? '<span class="tt-novel-chip is-ok">基准线</span>' : (evt.timelinePhase === 'flashback' ? '<span class="tt-novel-chip is-warn">倒叙</span>' : '')}
                                ${evt.pov ? `<span class="tt-novel-chip">视角:${escapeHtml(evt.pov)}</span>` : ''}
                                <strong>${escapeHtml(evt.title)}</strong>
                                ${evt.timeLabel ? `<span class="tt-novel-muted">${escapeHtml(evt.timeLabel)}</span>` : ''}
                            </div>
                            <div class="tt-novel-card-actions">
                                <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-evt" data-id="${escapeHtml(evt.id)}" title="编辑">${uiIcon('edit', 13)}</button>
                                <button type="button" class="tt-novel-mini-icon-btn" data-action="del-evt" data-id="${escapeHtml(evt.id)}" title="删除">${uiIcon('trash', 13)}</button>
                            </div>
                        </div>
                        ${(evt.participants || []).length > 0 ? `<div class="tt-novel-chip-row">${evt.participants.map(p => `<span class="tt-novel-chip">${escapeHtml(p)}</span>`).join('')}</div>` : ''}
                        <div class="tt-novel-card-text">${escapeHtml(evt.summary)}</div>
                        ${evt.povKnown ? `<div class="tt-novel-infogap">视角已知：${escapeHtml(evt.povKnown)}</div>` : ''}
                        ${evt.povBlindspot ? `<div class="tt-novel-infogap">视角盲区：${escapeHtml(evt.povBlindspot)}</div>` : ''}
                        ${evt.infoGap ? `<div class="tt-novel-infogap">信息差：${escapeHtml(evt.infoGap)}</div>` : ''}
                    </div>
                `;
            }).join('');

        activeSectionHtml = `
            <section class="tt-novel-section">
                <div class="tt-novel-card-head">
                    <div class="tt-novel-section-title">剧情编年史（${chronicle.length}）</div>
                    <button type="button" id="tt-novel-add-evt" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 新增事件</button>
                </div>
                <div class="tt-novel-card-stack">${chronicleHtml}</div>
            </section>
        `;
    } else if (memoryFilter === 'hooks') {
        const renderHookItem = (h) => {
            if (editingHookId === h.id) {
                return `
                    <div class="tt-novel-card is-editing" data-hook-id="${escapeHtml(h.id)}">
                        <div class="tt-novel-edit-grid">
                            <div class="tt-novel-row-2">
                                <input type="number" class="text_pole" data-field="plantedChapter" min="1" value="${Number(h.plantedChapter || 1)}" placeholder="埋下章号" />
                                <select class="text_pole" data-field="status">
                                    <option value="open" ${h.status === 'open' ? 'selected' : ''}>长期暗线</option>
                                    <option value="pinned" ${h.status === 'pinned' ? 'selected' : ''}>本章重点推进</option>
                                    <option value="resolved" ${h.status === 'resolved' ? 'selected' : ''}>已回收</option>
                                </select>
                            </div>
                            <textarea class="text_pole" rows="2" data-field="content" placeholder="伏笔内容">${escapeHtml(h.content || '')}</textarea>
                        </div>
                        <div class="tt-novel-card-actions">
                            <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="save-hook" data-id="${escapeHtml(h.id)}">保存</button>
                            <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-hook">取消</button>
                        </div>
                    </div>
                `;
            }
            return `
                <div class="tt-novel-hook-row ${h.status === 'pinned' ? 'is-pinned' : ''} ${h.status === 'resolved' ? 'is-resolved' : ''}">
                    <div class="tt-novel-hook-text">
                        <span class="tt-novel-chip ${h.status === 'pinned' ? 'is-gold' : ''}">#${Number(h.plantedChapter || 1)}${h.status === 'pinned' ? ' 重点' : ''}</span>
                        <span>${escapeHtml(h.content)}</span>
                        ${h.resolvedChapter ? `<span class="tt-novel-muted">（第${h.resolvedChapter}章回收）</span>` : ''}
                    </div>
                    <div class="tt-novel-card-actions">
                        ${h.status !== 'resolved' ? `<button type="button" class="tt-novel-mini-icon-btn ${h.status === 'pinned' ? 'is-active' : ''}" data-action="pin-hook" data-id="${escapeHtml(h.id)}" title="${h.status === 'pinned' ? '取消重点推进' : '设为重点推进'}">${uiIcon('pin', 13)}</button>` : ''}
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-hook" data-id="${escapeHtml(h.id)}" title="编辑">${uiIcon('edit', 13)}</button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="resolve-hook" data-id="${escapeHtml(h.id)}" title="${h.status === 'resolved' ? '重新打开' : '标记已回收'}">${h.status === 'resolved' ? uiIcon('undo', 13) : uiIcon('check', 13)}</button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="del-hook" data-id="${escapeHtml(h.id)}" title="删除">${uiIcon('trash', 13)}</button>
                    </div>
                </div>
            `;
        };

        const hooksHtml = hooks.length === 0
            ? '<div class="tt-novel-empty">暂无伏笔记录。可手动埋线，或由每章总结自动提取。</div>'
            : `
                ${openHooks.map(renderHookItem).join('')}
                ${resolvedHooks.length > 0 ? `<details class="tt-novel-subtle-fold"><summary>已回收伏笔（${resolvedHooks.length}）</summary><div class="tt-novel-card-stack" style="margin-top: 6px;">${resolvedHooks.map(renderHookItem).join('')}</div></details>` : ''}
            `;

        activeSectionHtml = `
            <section class="tt-novel-section">
                <div class="tt-novel-card-head">
                    <div class="tt-novel-section-title">伏笔与暗线（待填 ${openHooks.length}）</div>
                    <button type="button" id="tt-novel-add-hook" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 新增伏笔</button>
                </div>
                <div class="tt-novel-card-stack">${hooksHtml}</div>
            </section>
        `;
    } else if (memoryFilter === 'world') {
        const worldRowsHtml = worldStates.map((w, idx) => {
            const wsId = w.id || `ws_idx_${idx}`;
            if (editingWorldStateId === wsId) {
                return `
                    <div class="tt-novel-card is-editing" data-ws-id="${escapeHtml(wsId)}">
                        <div class="tt-novel-edit-grid">
                            <div class="tt-novel-row-3">
                                <input type="text" class="text_pole" data-field="category" value="${escapeHtml(w.category || '人物')}" placeholder="分类" />
                                <input type="text" class="text_pole" data-field="name" value="${escapeHtml(w.name || '')}" placeholder="条目名" />
                                <input type="number" class="text_pole" data-field="effectiveChapter" min="1" value="${Number(w.effectiveChapter || 1)}" placeholder="章号" />
                            </div>
                            <textarea class="text_pole" rows="2" data-field="state" placeholder="状态描述">${escapeHtml(w.state || '')}</textarea>
                        </div>
                        <div class="tt-novel-card-actions">
                            <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="save-ws" data-id="${escapeHtml(wsId)}">保存</button>
                            <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-ws">取消</button>
                        </div>
                    </div>
                `;
            }
            return `
                <div class="tt-novel-state-row tt-novel-state-crud-row">
                    <div class="tt-novel-state-main">
                        <span class="tt-novel-chip">${escapeHtml(w.category || '状态')} · ${escapeHtml(w.name)}</span>
                        <span class="tt-novel-muted">#${Number(w.effectiveChapter || 1)}</span>
                        <span>${escapeHtml(w.state)}</span>
                    </div>
                    <div class="tt-novel-card-actions">
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-ws" data-id="${escapeHtml(wsId)}" title="编辑">${uiIcon('edit', 13)}</button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="del-ws" data-id="${escapeHtml(wsId)}" title="删除">${uiIcon('trash', 13)}</button>
                    </div>
                </div>
            `;
        }).join('');

        const summaryRowsHtml = summaries.map(sum => {
            const chNum = Number(sum.chapterIndex || 0);
            if (editingSummaryChapter === chNum) {
                return `
                    <div class="tt-novel-card is-editing" data-sum-ch="${chNum}">
                        <div class="tt-novel-edit-grid">
                            <div class="tt-novel-row-2">
                                <input type="number" class="text_pole" data-field="chapterIndex" min="1" value="${chNum}" placeholder="章号" />
                                <input type="text" class="text_pole" data-field="title" value="${escapeHtml(sum.title || '')}" placeholder="章节标题" />
                            </div>
                            <textarea class="text_pole" rows="3" data-field="summary" placeholder="单章四要素摘要">${escapeHtml(sum.summary || '')}</textarea>
                        </div>
                        <div class="tt-novel-card-actions">
                            <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="save-sum" data-ch="${chNum}">保存</button>
                            <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-sum">取消</button>
                        </div>
                    </div>
                `;
            }
            return `
                <div class="tt-novel-state-row tt-novel-state-crud-row">
                    <div class="tt-novel-state-main">
                        <span class="tt-novel-chip is-gold">第${chNum}章</span>
                        ${sum.title ? `<strong>${escapeHtml(sum.title)}</strong>` : ''}
                        <span>${escapeHtml(sum.summary)}</span>
                    </div>
                    <div class="tt-novel-card-actions">
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-sum" data-ch="${chNum}" title="编辑">${uiIcon('edit', 13)}</button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="del-sum" data-ch="${chNum}" title="删除">${uiIcon('trash', 13)}</button>
                    </div>
                </div>
            `;
        }).join('');

        const bodyContent = (worldStates.length === 0 && summaries.length === 0)
            ? '<div class="tt-novel-empty">暂无状态条目或单章摘要。</div>'
            : `
                ${summaries.length > 0 ? `<div class="tt-novel-subhead">单章四要素总结（${summaries.length}）</div><div class="tt-novel-card-stack">${summaryRowsHtml}</div>` : ''}
                ${worldStates.length > 0 ? `<div class="tt-novel-subhead">势力 / 物品 / 外观状态（${worldStates.length}）</div><div class="tt-novel-card-stack">${worldRowsHtml}</div>` : ''}
            `;

        activeSectionHtml = `
            <section class="tt-novel-section">
                <div class="tt-novel-card-head">
                    <div class="tt-novel-section-title">单章总结与世界状态</div>
                    <div class="tt-novel-card-actions">
                        <button type="button" id="tt-novel-add-sum-inline" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 摘要</button>
                        <button type="button" id="tt-novel-add-ws-inline" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 状态</button>
                    </div>
                </div>
                ${bodyContent}
            </section>
        `;
    } else if (memoryFilter === 'canon') {
        const nCfg = normalizeNarrativeConfig(ledger.narrativeConfig);
        const activePackSet = new Set(nCfg.activeLorePackIds || []);
        const tavernWorlds = handlers.listAvailableTavernWorldbooks?.() || [];
        const packs = Array.isArray(cachedGlobalLorePacks) ? cachedGlobalLorePacks : [];
        const activeGlobalItems = Array.isArray(cachedActiveLoreBundle?.items)
            ? cachedActiveLoreBundle.items.filter(it => !canonItems.includes(it))
            : [];

        const worldSelectOptions = tavernWorlds.length > 0
            ? tavernWorlds.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')
            : '<option value="">未检测到酒馆世界书</option>';

        const packsHtml = packs.length === 0
            ? '<div class="tt-novel-empty">还没有全局同人资料库包。点上方从酒馆世界书一键清洗导入（或上传本地 JSON/MD），一次导入即可跨所有小说与角色卡复用。</div>'
            : packs.map(p => {
                const isOn = activePackSet.has(p.id);
                const statChips = [
                    `<span class="tt-novel-chip is-gold">核心 ${Number(p.keptEntries || p.itemCount || 0)} 条</span>`,
                    `<span class="tt-novel-chip">索引 ${Number(p.itemCount || 0)} 块</span>`,
                    ...(Number(p.skippedDisabled || 0) > 0 ? [`<span class="tt-novel-chip">跳过 ${p.skippedDisabled} 禁用</span>`] : []),
                    ...(Number(p.skippedNoise || 0) > 0 ? [`<span class="tt-novel-chip">滤除 ${p.skippedNoise} 跑团杂项</span>`] : []),
                    ...(Number(p.sanitizedEjsCount || 0) > 0 ? [`<span class="tt-novel-chip">清洗 ${p.sanitizedEjsCount} EJS</span>`] : []),
                    ...(Number(p.regexKeyCount || 0) > 0 ? [`<span class="tt-novel-chip">兼容 ${p.regexKeyCount} 正则</span>`] : []),
                ].join('');
                return `
                    <div class="tt-novel-pack-card ${isOn ? 'is-active' : ''}" data-pack-id="${escapeHtml(p.id)}">
                        <div class="tt-novel-pack-head">
                            <label class="tt-novel-pack-check">
                                <input type="checkbox" data-action="toggle-lore-pack" data-pack-id="${escapeHtml(p.id)}" ${isOn ? 'checked' : ''} />
                                <span>${escapeHtml(p.name || '未命名资料库')}</span>
                            </label>
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="del-lore-pack" data-pack-id="${escapeHtml(p.id)}" title="删除此全局资料库包">${uiIcon('trash', 13)}</button>
                        </div>
                        <div class="tt-novel-pack-stats">${statChips}</div>
                    </div>
                `;
            }).join('');

        const canonQ = canonSearchQuery.trim().toLowerCase();
        const combinedSearchPool = [
            ...canonItems.map(it => ({ ...it, _isPrivate: true })),
            ...(canonQ ? activeGlobalItems.map(it => ({ ...it, _isPrivate: false })) : []),
        ];
        const filteredCanon = canonQ
            ? combinedSearchPool.filter(it =>
                `${it.title || ''} ${it.category || ''} ${it.source || ''} ${(it.keywords || []).join(' ')} ${it.content || ''}`.toLowerCase().includes(canonQ),
            )
            : combinedSearchPool;

        const canonHtml = combinedSearchPool.length === 0 && !canonQ
            ? (activeGlobalItems.length > 0
                ? `<div class="tt-novel-empty">已启用全局资料库（共 ${activeGlobalItems.length} 条可检索分块）。在上方搜索框输入角色名（如 白金 / 塑心 / 椿）即可实时查验清洗后的词条，或点右侧新增本书私有设定。</div>`
                : '<div class="tt-novel-empty">当前对话私有设定为空。可先在上方导入全局同人资料库包，或点右侧新增单条私有设定。</div>')
            : (filteredCanon.length === 0
                ? '<div class="tt-novel-empty">未找到匹配的设定词条。</div>'
                : filteredCanon.slice(0, 50).map(it => {
                    if (it._isPrivate && editingCanonId === it.id) {
                        return `
                            <div class="tt-novel-card is-editing" data-canon-id="${escapeHtml(it.id)}">
                                <div class="tt-novel-edit-grid">
                                    <div class="tt-novel-row-2">
                                        <input type="text" class="text_pole" data-field="title" value="${escapeHtml(it.title || '')}" placeholder="设定标题" />
                                        <input type="text" class="text_pole" data-field="category" value="${escapeHtml(it.category || '世界设定')}" placeholder="分类" />
                                    </div>
                                    <input type="text" class="text_pole" data-field="keywords" value="${escapeHtml((it.keywords || []).join('、'))}" placeholder="触发关键词（顿号/逗号分隔）" />
                                    <textarea class="text_pole" rows="3" data-field="content" placeholder="设定内容">${escapeHtml(it.content || '')}</textarea>
                                </div>
                                <div class="tt-novel-card-actions">
                                    <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="save-canon" data-id="${escapeHtml(it.id)}">保存</button>
                                    <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-canon">取消</button>
                                </div>
                            </div>
                        `;
                    }
                    return `
                        <div class="tt-novel-card">
                            <div class="tt-novel-card-head">
                                <div class="tt-novel-timeline-meta">
                                    <span class="tt-novel-chip">${escapeHtml(it.category || '世界设定')}</span>
                                    ${it._isPrivate ? '' : `<span class="tt-novel-chip is-gold">${escapeHtml(it.source || '全局库')}</span>`}
                                    <strong>${escapeHtml(it.title || '未命名设定')}</strong>
                                </div>
                                ${it._isPrivate ? `
                                    <div class="tt-novel-card-actions">
                                        <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-canon" data-id="${escapeHtml(it.id)}" title="编辑">${uiIcon('edit', 13)}</button>
                                        <button type="button" class="tt-novel-mini-icon-btn" data-action="del-canon" data-id="${escapeHtml(it.id)}" title="删除">${uiIcon('trash', 13)}</button>
                                    </div>
                                ` : ''}
                            </div>
                            ${(it.keywords || []).length > 0 ? `<div class="tt-novel-chip-row">${it.keywords.slice(0, 8).map(k => `<span class="tt-novel-chip is-gold">${escapeHtml(k)}</span>`).join('')}</div>` : ''}
                            <div class="tt-novel-card-text">${escapeHtml(String(it.content || '').slice(0, 420))}${String(it.content || '').length > 420 ? '……' : ''}</div>
                        </div>
                    `;
                }).join(''));

        activeSectionHtml = `
            <section class="tt-novel-card">
                <div class="tt-novel-card-head">
                    <div class="tt-novel-section-title">全局同人资料库包（跨书复用 · 已启用 ${cachedActiveLoreBundle?.activePacks?.length || 0}/${packs.length}）</div>
                    <label class="menu_button tt-novel-btn-sm tt-novel-file-label">
                        ${uiIcon('upload', 12)} 导入本地文件
                        <input type="file" id="tt-novel-import-global-lore" accept=".json,.jsonl,.md,.txt,application/json,text/plain,*/*" multiple hidden />
                    </label>
                </div>
                <div class="tt-novel-edit-grid" style="margin-top: 8px;">
                    <div class="tt-novel-bridge-row">
                        <select id="tt-novel-tavern-world-select" class="text_pole" ${tavernWorlds.length === 0 ? 'disabled' : ''}>${worldSelectOptions}</select>
                        <button type="button" id="tt-novel-import-tavern-world" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" ${tavernWorlds.length === 0 ? 'disabled' : ''}>清洗并导入</button>
                    </div>
                    <label class="tt-novel-check-row">
                        <input type="checkbox" id="tt-novel-lore-include-core" ${nCfg.includeLorePackWorldCore !== false ? 'checked' : ''} />
                        <span>自动附带已启用资料库的精简世界观总纲（每包限 1,800 字，拒绝爆上下文）</span>
                    </label>
                    ${(cachedActiveLoreBundle?.activePacks?.length || 0) > 0
                        ? '<div class="tt-novel-muted">已启用纯净资料库：建议关闭酒馆原生同名大世界书，让插件按章精准召回完整角色档案（单条上限 1,400 字）。</div>'
                        : ''}
                    <div class="tt-novel-card-stack">${packsHtml}</div>
                </div>
            </section>

            <section class="tt-novel-section">
                <div class="tt-novel-card-head">
                    <div class="tt-novel-section-title">词条检索与私有设定（私有 ${canonItems.length} · 已启全局 ${activeGlobalItems.length}）</div>
                    <button type="button" id="tt-novel-add-canon-inline" class="menu_button tt-novel-btn-sm">${uiIcon('plus', 12)} 新增私有设定</button>
                </div>
                <input type="search" id="tt-novel-canon-search" class="text_pole" value="${escapeHtml(canonSearchQuery)}" placeholder="搜角色名、势力或关键词（可跨已启用的全局资料库与私有设定实时查验）..." />
                <div class="tt-novel-card-stack">${canonHtml}</div>
            </section>
        `;
    }

    bodyEl.innerHTML = `
        <div class="tt-novel-toolbar">
            <button type="button" id="${primaryActionId}" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                ${escapeHtml(primaryActionLabel)}
            </button>
            <details class="tt-novel-menu-drop">
                <summary class="menu_button tt-novel-btn-sm">更多维护 ${uiIcon('chevronDown', 12)}</summary>
                <div class="tt-novel-menu-panel">
                    ${primaryActionId !== 'tt-novel-run-archive-full' ? `<button type="button" id="tt-novel-run-archive-full" class="tt-novel-menu-item" ${task.running ? 'disabled' : ''}>全本通读归档</button>` : ''}
                    ${primaryActionId !== 'tt-novel-run-archive-inc' ? `<button type="button" id="tt-novel-run-archive-inc" class="tt-novel-menu-item" ${task.running ? 'disabled' : ''}>增量归档新章${unarchivedGap > 0 ? ` (+${unarchivedGap})` : ''}</button>` : ''}
                    ${primaryActionId !== 'tt-novel-backfill-sums' ? `<button type="button" id="tt-novel-backfill-sums" class="tt-novel-menu-item" ${task.running ? 'disabled' : ''}>补齐缺失单章总结${missingSumCount > 0 ? ` (+${missingSumCount})` : ''}</button>` : ''}
                    <button type="button" id="tt-novel-auto-detect-btn" class="tt-novel-menu-item" ${task.running ? 'disabled' : ''}>自动识别视角与双线</button>
                </div>
            </details>
            <div class="tt-novel-spacer"></div>
            <button type="button" id="tt-novel-jump-narrative" class="tt-novel-link-pill" title="前往设置修改叙事视角与世界书规则">${escapeHtml(povChipText)}</button>
        </div>

        <div class="tt-novel-subfilter" role="tablist">
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'chars' ? 'active' : ''}" data-filter="chars">人物 (${chars.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'chronicle' ? 'active' : ''}" data-filter="chronicle">编年史 (${chronicle.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'hooks' ? 'active' : ''}" data-filter="hooks">伏笔 (${openHooks.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'world' ? 'active' : ''}" data-filter="world">状态 (${worldStates.length + summaries.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'canon' ? 'active' : ''}" data-filter="canon">设定库 (${(cachedActiveLoreBundle?.activePacks?.length || 0) > 0 ? `${cachedActiveLoreBundle.activePacks.length}包/` : ''}${canonItems.length})</button>
        </div>

        ${progressHtml}
        ${sliceManagerHtml}
        ${logHtml}
        ${activeSectionHtml}
    `;

    bodyEl.querySelector('#tt-novel-jump-narrative')?.addEventListener('click', () => {
        void openWorkbench('settings', { settingsSection: 'narrative' });
    });
    bodyEl.querySelector('#tt-novel-auto-detect-btn')?.addEventListener('click', () => handlers.onAutoDetectNarrativeStructure?.());
    bodyEl.querySelector('#tt-novel-run-archive-full')?.addEventListener('click', () => handlers.onRunArchive?.('full'));
    bodyEl.querySelector('#tt-novel-run-archive-inc')?.addEventListener('click', () => handlers.onRunArchive?.('incremental'));
    bodyEl.querySelector('#tt-novel-backfill-sums')?.addEventListener('click', () => handlers.onBackfillChapterSummaries?.());
    bodyEl.querySelector('#tt-novel-rerun-failed-slices')?.addEventListener('click', () => handlers.onRerunFailedArchiveBatches?.());
    bodyEl.querySelector('#tt-novel-resynth-slices')?.addEventListener('click', () => handlers.onResynthArchive?.());
    bodyEl.querySelectorAll('[data-action="rerun-slice"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.getAttribute('data-batch'));
            if (idx > 0) handlers.onRerunArchiveBatch?.(idx);
        });
    });
    bodyEl.querySelectorAll('.tt-novel-filter-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            memoryFilter = btn.getAttribute('data-filter') || 'chars';
            renderWorkbench();
        });
    });

    bodyEl.querySelector('#tt-novel-add-char')?.addEventListener('click', async () => {
        const name = window.prompt('请输入人物姓名：');
        if (!name || !name.trim()) return;
        const cur = await loadLedger();
        const newChar = {
            id: `char_manual_${Date.now()}`,
            name: name.trim(),
            role: '',
            canonFoundation: '',
            currentAppearance: '',
            currentSituation: '',
            voiceAndQuotes: '',
            oocRedLines: '',
            updatedChapter: Number(cachedNovelData?.cutoffChapterIndex || 1),
        };
        cur.characters.push(newChar);
        await saveLedger(cur);
        editingCharacterId = newChar.id;
        memoryFilter = 'chars';
        await refreshReaderWidgets();
    });

    bodyEl.querySelector('#tt-novel-add-evt')?.addEventListener('click', async () => {
        const title = window.prompt('请输入编年史事件标题：');
        if (!title || !title.trim()) return;
        const cur = await loadLedger();
        const chIdx = Number(cachedNovelData?.cutoffChapterIndex || 1);
        const newEvt = {
            id: `evt_manual_${Date.now()}`,
            title: title.trim(),
            chapterRange: `#${chIdx}`,
            startChapter: chIdx,
            endChapter: chIdx,
            timeLabel: '',
            pov: nCfg.povCharacter || '',
            timelinePhase: 'main',
            participants: [],
            summary: '',
            infoGap: '',
            povKnown: '',
            povBlindspot: '',
        };
        cur.chronicle.push(newEvt);
        await saveLedger(cur);
        editingEventId = newEvt.id;
        memoryFilter = 'chronicle';
        await refreshReaderWidgets();
    });

    bodyEl.querySelector('#tt-novel-add-hook')?.addEventListener('click', async () => {
        const text = window.prompt('请输入伏笔线索：');
        if (!text || !text.trim()) return;
        const cur = await loadLedger();
        cur.hooks.push({
            id: `hook_${Date.now()}`,
            content: text.trim(),
            plantedChapter: Number(cachedNovelData?.cutoffChapterIndex || 1),
            status: 'pinned',
        });
        await saveLedger(cur);
        await refreshReaderWidgets();
    });

    bodyEl.querySelector('#tt-novel-add-ws-inline')?.addEventListener('click', async () => {
        const name = window.prompt('请输入状态条目名（角色/物品/势力）：');
        if (!name || !name.trim()) return;
        const cur = await loadLedger();
        const chIdx = Number(cachedNovelData?.cutoffChapterIndex || 1);
        const newWs = {
            id: `ws_manual_${Date.now()}`,
            category: '人物',
            name: name.trim(),
            state: '',
            effectiveChapter: chIdx,
            updatedAt: Date.now(),
        };
        cur.worldStates.push(newWs);
        await saveLedger(cur);
        editingWorldStateId = newWs.id;
        memoryFilter = 'world';
        await refreshReaderWidgets();
    });

    bodyEl.querySelector('#tt-novel-add-sum-inline')?.addEventListener('click', async () => {
        const rawCh = window.prompt('请输入摘要对应的章号：', String(Number(cachedAnchorInfo?.prevChapterIndex || 0) + 1));
        const chNum = Number(rawCh);
        if (!Number.isFinite(chNum) || chNum < 1) return;
        const cur = await loadLedger();
        cur.summaries = cur.summaries.filter(x => Number(x.chapterIndex) !== chNum);
        cur.summaries.push({
            chapterIndex: chNum,
            floorIndex: null,
            title: `第 ${chNum} 章`,
            summary: '',
            updatedAt: Date.now(),
        });
        cur.summaries.sort((a, b) => a.chapterIndex - b.chapterIndex);
        await saveLedger(cur);
        editingSummaryChapter = chNum;
        memoryFilter = 'world';
        await refreshReaderWidgets();
    });

    bodyEl.querySelector('#tt-novel-add-canon-inline')?.addEventListener('click', async () => {
        const title = window.prompt('请输入新增设定条目标题：');
        if (!title || !title.trim()) return;
        const curCanon = await loadCanonDb();
        const newItem = {
            id: `canon_manual_${Date.now()}`,
            title: title.trim(),
            category: '世界设定',
            keywords: [title.trim()],
            content: '',
            source: '手动录入',
        };
        curCanon.items.unshift(newItem);
        await saveCanonDb(curCanon);
        editingCanonId = newItem.id;
        memoryFilter = 'canon';
        await refreshReaderWidgets();
    });

    bodyEl.querySelector('#tt-novel-canon-search')?.addEventListener('input', debounce((e) => {
        canonSearchQuery = String(e.target.value || '');
        renderWorkbench();
    }, 180));

    // Character CRUD bindings
    bodyEl.querySelectorAll('[data-action="edit-char"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingCharacterId = btn.getAttribute('data-id');
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="cancel-char"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingCharacterId = null;
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="save-char"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const card = bodyEl.querySelector(`.tt-novel-char-card[data-char-id="${CSS.escape(id)}"]`);
            if (!card) return;
            const cur = await loadLedger();
            const target = cur.characters.find(c => c.id === id);
            if (target) {
                const val = (f) => String(card.querySelector(`[data-field="${f}"]`)?.value || '').trim();
                target.name = val('name') || target.name;
                target.role = val('role');
                target.currentAppearance = val('currentAppearance');
                target.canonFoundation = val('canonFoundation');
                target.currentSituation = val('currentSituation');
                target.voiceAndQuotes = val('voiceAndQuotes');
                target.oocRedLines = val('oocRedLines');
                await saveLedger(cur);
            }
            editingCharacterId = null;
            await refreshReaderWidgets();
        });
    });
    bodyEl.querySelectorAll('[data-action="del-char"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const cur = await loadLedger();
            cur.characters = cur.characters.filter(c => c.id !== id);
            await saveLedger(cur);
            await refreshReaderWidgets();
        });
    });

    // Event CRUD bindings
    bodyEl.querySelectorAll('[data-action="edit-evt"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingEventId = btn.getAttribute('data-id');
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="cancel-evt"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingEventId = null;
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="save-evt"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const card = bodyEl.querySelector(`.tt-novel-card[data-evt-id="${CSS.escape(id)}"]`);
            if (!card) return;
            const cur = await loadLedger();
            const target = cur.chronicle.find(e => e.id === id);
            if (target) {
                const val = (f) => String(card.querySelector(`[data-field="${f}"]`)?.value || '').trim();
                const rangeStr = val('chapterRange') || target.chapterRange;
                const nums = [...rangeStr.matchAll(/\d+/g)].map(m => Number(m[0])).filter(n => n > 0);
                target.chapterRange = rangeStr;
                if (nums.length > 0) {
                    target.startChapter = nums[0];
                    target.endChapter = nums[nums.length - 1];
                }
                target.timeLabel = val('timeLabel');
                const tp = val('timelinePhase');
                target.timelinePhase = (tp === 'reference' || tp === 'flashback') ? tp : 'main';
                target.pov = val('pov');
                target.title = val('title') || target.title;
                target.participants = val('participants').split(/[、,，\s]+/).filter(Boolean);
                target.summary = val('summary') || target.summary;
                target.infoGap = val('infoGap');
                target.povKnown = val('povKnown');
                target.povBlindspot = val('povBlindspot');
                cur.chronicle.sort((a, b) => (a.startChapter || 0) - (b.startChapter || 0));
                await saveLedger(cur);
            }
            editingEventId = null;
            await refreshReaderWidgets();
        });
    });
    bodyEl.querySelectorAll('[data-action="del-evt"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const cur = await loadLedger();
            cur.chronicle = cur.chronicle.filter(e => e.id !== id);
            await saveLedger(cur);
            await refreshReaderWidgets();
        });
    });

    // Hook CRUD bindings
    bodyEl.querySelectorAll('[data-action="edit-hook"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingHookId = btn.getAttribute('data-id');
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="cancel-hook"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingHookId = null;
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="save-hook"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const card = bodyEl.querySelector(`.tt-novel-card[data-hook-id="${CSS.escape(id)}"]`);
            if (!card) return;
            const cur = await loadLedger();
            const target = cur.hooks.find(h => h.id === id);
            if (target) {
                const content = String(card.querySelector('[data-field="content"]')?.value || '').trim();
                const planted = Number(card.querySelector('[data-field="plantedChapter"]')?.value || target.plantedChapter || 1);
                const status = String(card.querySelector('[data-field="status"]')?.value || target.status || 'open');
                if (content) target.content = content;
                if (Number.isFinite(planted) && planted >= 1) target.plantedChapter = planted;
                target.status = status;
                if (status === 'resolved' && !target.resolvedChapter) {
                    target.resolvedChapter = Number(cachedNovelData?.cutoffChapterIndex || planted);
                } else if (status !== 'resolved') {
                    delete target.resolvedChapter;
                }
                await saveLedger(cur);
            }
            editingHookId = null;
            await refreshReaderWidgets();
        });
    });
    bodyEl.querySelectorAll('[data-action="pin-hook"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const cur = await loadLedger();
            const target = cur.hooks.find(h => h.id === id);
            if (target) {
                target.status = target.status === 'pinned' ? 'open' : 'pinned';
                await saveLedger(cur);
                await refreshReaderWidgets();
            }
        });
    });
    bodyEl.querySelectorAll('[data-action="resolve-hook"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const cur = await loadLedger();
            const target = cur.hooks.find(h => h.id === id);
            if (target) {
                if (target.status === 'resolved') {
                    target.status = 'open';
                    delete target.resolvedChapter;
                } else {
                    target.status = 'resolved';
                    target.resolvedChapter = Number(cachedNovelData?.cutoffChapterIndex || 1);
                }
                await saveLedger(cur);
                await refreshReaderWidgets();
            }
        });
    });
    bodyEl.querySelectorAll('[data-action="del-hook"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const cur = await loadLedger();
            cur.hooks = cur.hooks.filter(h => h.id !== id);
            await saveLedger(cur);
            await refreshReaderWidgets();
        });
    });

    // WorldState CRUD bindings
    bodyEl.querySelectorAll('[data-action="edit-ws"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingWorldStateId = btn.getAttribute('data-id');
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="cancel-ws"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingWorldStateId = null;
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="save-ws"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const card = bodyEl.querySelector(`.tt-novel-card[data-ws-id="${CSS.escape(id)}"]`);
            if (!card) return;
            const cur = await loadLedger();
            const idx = cur.worldStates.findIndex((w, i) => (w.id || `ws_idx_${i}`) === id);
            if (idx >= 0) {
                const val = (f) => String(card.querySelector(`[data-field="${f}"]`)?.value || '').trim();
                const ch = Number(val('effectiveChapter')) || 1;
                cur.worldStates[idx] = {
                    ...cur.worldStates[idx],
                    id: cur.worldStates[idx].id || id,
                    category: val('category') || '人物',
                    name: val('name') || cur.worldStates[idx].name,
                    state: val('state'),
                    effectiveChapter: Math.max(1, ch),
                    updatedAt: Date.now(),
                };
                await saveLedger(cur);
            }
            editingWorldStateId = null;
            await refreshReaderWidgets();
        });
    });
    bodyEl.querySelectorAll('[data-action="del-ws"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const cur = await loadLedger();
            cur.worldStates = cur.worldStates.filter((w, i) => (w.id || `ws_idx_${i}`) !== id);
            await saveLedger(cur);
            await refreshReaderWidgets();
        });
    });

    // Summary CRUD bindings
    bodyEl.querySelectorAll('[data-action="edit-sum"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingSummaryChapter = Number(btn.getAttribute('data-ch'));
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="cancel-sum"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingSummaryChapter = null;
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="save-sum"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const origCh = Number(btn.getAttribute('data-ch'));
            const card = bodyEl.querySelector(`.tt-novel-card[data-sum-ch="${origCh}"]`);
            if (!card) return;
            const cur = await loadLedger();
            const target = cur.summaries.find(x => Number(x.chapterIndex) === origCh);
            if (target) {
                const val = (f) => String(card.querySelector(`[data-field="${f}"]`)?.value || '').trim();
                const newCh = Number(val('chapterIndex')) || origCh;
                target.chapterIndex = Math.max(1, newCh);
                target.title = val('title') || `第 ${target.chapterIndex} 章`;
                target.summary = val('summary');
                target.updatedAt = Date.now();
                cur.summaries.sort((a, b) => a.chapterIndex - b.chapterIndex);
                await saveLedger(cur);
            }
            editingSummaryChapter = null;
            await refreshReaderWidgets();
        });
    });
    bodyEl.querySelectorAll('[data-action="del-sum"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const chNum = Number(btn.getAttribute('data-ch'));
            const cur = await loadLedger();
            cur.summaries = cur.summaries.filter(x => Number(x.chapterIndex) !== chNum);
            await saveLedger(cur);
            await refreshReaderWidgets();
        });
    });

    // Global Reusable Lore Packs bindings
    bodyEl.querySelector('#tt-novel-import-global-lore')?.addEventListener('change', async (e) => {
        const files = [...(e.target.files || [])];
        if (files.length > 0) await handlers.onImportGlobalLoreFiles?.(files);
        e.target.value = '';
    });
    bodyEl.querySelector('#tt-novel-import-tavern-world')?.addEventListener('click', async () => {
        const bookName = String(bodyEl.querySelector('#tt-novel-tavern-world-select')?.value || '').trim();
        if (!bookName) {
            globalThis.toastr?.warning?.('请先选择一本酒馆世界书', '小说工作台');
            return;
        }
        await handlers.onImportTavernWorldbookAsLorePack?.(bookName);
    });
    bodyEl.querySelector('#tt-novel-lore-include-core')?.addEventListener('change', async (e) => {
        await handlers.onUpdateNarrativeConfig?.({ includeLorePackWorldCore: Boolean(e.target.checked) });
    });
    bodyEl.querySelectorAll('[data-action="toggle-lore-pack"]').forEach(chk => {
        chk.addEventListener('change', async (e) => {
            const packId = chk.getAttribute('data-pack-id');
            if (packId) await handlers.onToggleGlobalLorePack?.(packId, Boolean(e.target.checked));
        });
    });
    bodyEl.querySelectorAll('[data-action="del-lore-pack"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const packId = btn.getAttribute('data-pack-id');
            if (!packId) return;
            if (!window.confirm('确定删除这个全局同人资料库包吗？（不会影响酒馆原始世界书文件）')) return;
            await handlers.onDeleteGlobalLorePack?.(packId);
        });
    });

    // Canon DB CRUD bindings
    bodyEl.querySelectorAll('[data-action="edit-canon"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingCanonId = btn.getAttribute('data-id');
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="cancel-canon"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingCanonId = null;
            renderWorkbench();
        });
    });
    bodyEl.querySelectorAll('[data-action="save-canon"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const card = bodyEl.querySelector(`.tt-novel-card[data-canon-id="${CSS.escape(id)}"]`);
            if (!card) return;
            const curCanon = await loadCanonDb();
            const target = curCanon.items.find(it => it.id === id);
            if (target) {
                const val = (f) => String(card.querySelector(`[data-field="${f}"]`)?.value || '').trim();
                target.title = val('title') || target.title;
                target.category = val('category') || '世界设定';
                const kws = val('keywords').split(/[、,，;；\s]+/).map(k => k.trim()).filter(Boolean);
                target.keywords = kws.length > 0 ? kws : [target.title];
                target.content = val('content');
                await saveCanonDb(curCanon);
            }
            editingCanonId = null;
            await refreshReaderWidgets();
        });
    });
    bodyEl.querySelectorAll('[data-action="del-canon"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const curCanon = await loadCanonDb();
            curCanon.items = curCanon.items.filter(it => it.id !== id);
            await saveCanonDb(curCanon);
            await refreshReaderWidgets();
        });
    });
}

/* ==========================================================================
   TAB 3: 文风 (Segmented: 文风卡 | 精修重塑)
   ========================================================================== */
function renderCraftTab(bodyEl) {
    const clicheInfo = handlers.getLatestClicheStatus?.();
    const hits = Number(clicheInfo?.report?.totalHits || 0);

    const segHtml = `
        <div class="tt-novel-seg" role="tablist">
            <button type="button" class="tt-novel-seg-btn ${craftSubTab === 'style' ? 'active' : ''}" data-craft-sub="style">文风卡</button>
            <button type="button" class="tt-novel-seg-btn ${craftSubTab === 'rewrite' ? 'active' : ''}" data-craft-sub="rewrite">精修重塑${hits > 0 ? ` (${hits})` : ''}</button>
        </div>
    `;

    if (craftSubTab === 'rewrite') {
        renderRewriteSubView(bodyEl, segHtml);
    } else {
        renderStyleSubView(bodyEl, segHtml);
    }

    bodyEl.querySelectorAll('[data-craft-sub]').forEach(btn => {
        btn.addEventListener('click', () => {
            craftSubTab = btn.getAttribute('data-craft-sub') || 'style';
            renderWorkbench();
        });
    });
}

function renderStyleSubView(bodyEl, segHtml) {
    const settings = handlers.getSettings?.() || {};
    const sp = cachedLedger?.styleProfile || null;
    const task = liveTaskState.style;
    const logs = task.running && task.logs.length > 0 ? task.logs : (sp?.processLog || []);

    const scoreBadgeClass = (score) => {
        if (score === null || score === undefined) return '';
        if (score >= 88) return 'is-high';
        if (score >= 80) return 'is-mid';
        return 'is-low';
    };

    const processTimelineHtml = logs.length === 0
        ? '<div class="tt-novel-muted">尚无蒸馏记录。</div>'
        : logs.map(item => {
            if (item.type === 'round') {
                return `
                    <details class="tt-novel-round-card">
                        <summary class="tt-novel-round-head">
                            <span><strong>${escapeHtml(item.title || `第 ${item.round} 轮盲测`)}</strong></span>
                            <span class="tt-novel-score-pill ${scoreBadgeClass(item.score)}">
                                ${item.score !== null && item.score !== undefined ? `${item.score} / 100` : '已评估'}
                            </span>
                        </summary>
                        <div class="tt-novel-round-body">
                            ${item.driftReport ? `
                                <div class="tt-novel-diff-box is-cool">
                                    <div class="tt-novel-mini-label">本地客观指标比对</div>
                                    <div class="tt-novel-pre-wrap">${escapeHtml(item.driftReport)}</div>
                                </div>
                            ` : ''}
                            <div class="tt-novel-diff-box">
                                <div class="tt-novel-mini-label">5 维文风评分与修正（圣经 ${item.styleCardLength || '?'} 字）</div>
                                <div class="tt-novel-pre-wrap">${escapeHtml(item.diffNotes || '')}</div>
                            </div>
                            <details class="tt-novel-subfold">
                                <summary>盲测节拍考题</summary>
                                <div class="tt-novel-pre-wrap">${escapeHtml(item.dryOutline || '')}</div>
                            </details>
                            <details class="tt-novel-subfold">
                                <summary>原著真迹 vs AI 盲写对照</summary>
                                <div class="tt-novel-compare-grid">
                                    <div class="tt-novel-compare-col">
                                        <div class="tt-novel-mini-label">真迹（${escapeHtml(item.holdoutLabel || '')}）</div>
                                        <div class="tt-novel-compare-text">${escapeHtml(item.holdoutTruth || '')}</div>
                                    </div>
                                    <div class="tt-novel-compare-col">
                                        <div class="tt-novel-mini-label">盲测仿写</div>
                                        <div class="tt-novel-compare-text">${escapeHtml(item.blindRewrite || '')}</div>
                                    </div>
                                </div>
                            </details>
                        </div>
                    </details>
                `;
            }
            return `
                <details class="tt-novel-step-item">
                    <summary><strong>${escapeHtml(item.title || '')}</strong> <span class="tt-novel-muted">${escapeHtml(item.summary || '')}</span></summary>
                    <pre class="tt-novel-pre">${escapeHtml(item.detail || '')}</pre>
                </details>
            `;
        }).join('');

    const progressHtml = renderTaskProgressBanner('style', task);
    const cardLen = sp?.styleCard ? String(sp.styleCard).length : 0;
    const isBloatedCard = cardLen > 3500;
    const bloatedWarnHtml = isBloatedCard
        ? `<div class="tt-novel-banner is-warn">${statusDot('warn')} 当前文风卡共 ${cardLen} 字（偏长，易过拟合），建议点「提纯瘦身」压至约 2,200 字。</div>`
        : '';

    const customStyleOpen = !cachedNovelData?.chapters?.length && !sp?.styleCard;

    bodyEl.innerHTML = `
        ${segHtml}

        <div class="tt-novel-toolbar">
            <select id="tt-novel-wb-distill-rounds" class="text_pole tt-novel-compact-select" aria-label="盲测轮数">
                <option value="1" ${Number(settings.distillRounds) === 1 ? 'selected' : ''}>1 轮</option>
                <option value="2" ${Number(settings.distillRounds || 2) === 2 ? 'selected' : ''}>2 轮</option>
                <option value="3" ${Number(settings.distillRounds) === 3 ? 'selected' : ''}>3 轮</option>
            </select>
            <button type="button" id="tt-novel-wb-distill-start" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                对抗蒸馏
            </button>
            ${isBloatedCard ? `<button type="button" id="tt-novel-wb-compress-style" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>提纯瘦身</button>` : ''}
            <details class="tt-novel-menu-drop">
                <summary class="menu_button tt-novel-btn-sm">更多 ${uiIcon('chevronDown', 12)}</summary>
                <div class="tt-novel-menu-panel">
                    <button type="button" id="tt-novel-wb-distill-refine" class="tt-novel-menu-item" ${task.running || !sp?.styleCard ? 'disabled' : ''}>追加 1 轮精炼</button>
                    ${!isBloatedCard ? `<button type="button" id="tt-novel-wb-compress-style" class="tt-novel-menu-item" ${task.running || !sp?.styleCard ? 'disabled' : ''}>提纯瘦身</button>` : ''}
                    <button type="button" id="tt-novel-wb-eval-style" class="tt-novel-menu-item" ${task.running || !sp?.styleCard ? 'disabled' : ''}>纯跑分验收</button>
                </div>
            </details>
        </div>

        ${bloatedWarnHtml}
        ${progressHtml}

        <details class="tt-novel-accordion" ${customStyleOpen ? 'open' : ''}>
            <summary>
                <span>原创 / 定制文风卡</span>
                <span class="tt-novel-muted">零章适用 · 描述或贴样文</span>
            </summary>
            <div class="tt-novel-accordion-body">
                <div class="tt-novel-edit-grid">
                    <label>目标文风描述
                        <input type="text" id="tt-novel-custom-style-brief" class="text_pole" value="${escapeHtml(customStyleUiState.styleBrief || '')}" placeholder="如：冷峻克制、短段白描、少心理抒情、台词锋利" />
                    </label>
                    <label>参考范文（可选，仅提纯笔法不带入剧情）
                        <textarea id="tt-novel-custom-style-sample" class="text_pole" rows="4" placeholder="粘贴 300~5000 字样文...">${escapeHtml(customStyleUiState.referenceSample || '')}</textarea>
                    </label>
                    <div class="tt-novel-action-bar">
                        <button type="button" id="tt-novel-custom-style-gen" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                            生成定制文风卡
                        </button>
                    </div>
                </div>
            </div>
        </details>

        <section class="tt-novel-card">
            <div class="tt-novel-card-head">
                <div class="tt-novel-section-title">当前文风骨相卡 <span class="tt-novel-muted">（${sp?.styleCard ? `${cardLen} 字` : '未生成'}）</span></div>
                <div class="tt-novel-card-actions">
                    <button type="button" id="tt-novel-wb-save-style" class="menu_button tt-novel-btn-sm">保存</button>
                    <button type="button" id="tt-novel-wb-clear-style" class="tt-novel-mini-icon-btn" title="清空文风卡">${uiIcon('trash', 13)}</button>
                </div>
            </div>
            <textarea id="tt-novel-wb-style-editor" class="text_pole tt-novel-style-editor" rows="8" placeholder="文风骨相规则将显示在这里，可随时手动微调...">${escapeHtml(sp?.styleCard || '')}</textarea>
            <details class="tt-novel-subtle-fold">
                <summary>灵魂原文范例（Few-Shot）</summary>
                <textarea id="tt-novel-wb-excerpts-editor" class="text_pole tt-novel-style-editor" rows="5" style="margin-top: 6px;" placeholder="范例片段...">${escapeHtml(sp?.goldenExcerpts || '')}</textarea>
            </details>
        </section>

        ${logs.length > 0 ? `
            <details class="tt-novel-accordion" ${task.running ? 'open' : ''}>
                <summary>
                    <span>蒸馏过程记录</span>
                    <span class="tt-novel-muted">${logs.length} 条</span>
                </summary>
                <div class="tt-novel-accordion-body">
                    <div class="tt-novel-card-stack">${processTimelineHtml}</div>
                </div>
            </details>
        ` : ''}
    `;

    bodyEl.querySelector('#tt-novel-custom-style-brief')?.addEventListener('input', (e) => {
        customStyleUiState.styleBrief = String(e.target.value || '');
    });
    bodyEl.querySelector('#tt-novel-custom-style-sample')?.addEventListener('input', (e) => {
        customStyleUiState.referenceSample = String(e.target.value || '');
    });
    bodyEl.querySelector('#tt-novel-custom-style-gen')?.addEventListener('click', () => {
        const styleBrief = String(bodyEl.querySelector('#tt-novel-custom-style-brief')?.value || '').trim();
        const referenceSample = String(bodyEl.querySelector('#tt-novel-custom-style-sample')?.value || '').trim();
        customStyleUiState.styleBrief = styleBrief;
        customStyleUiState.referenceSample = referenceSample;
        handlers.onGenerateCustomStyleCard?.({ styleBrief, referenceSample });
    });
    bodyEl.querySelector('#tt-novel-wb-distill-rounds')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('distillRounds', Math.max(1, Math.min(3, Number(e.target.value) || 2)));
    });
    bodyEl.querySelector('#tt-novel-wb-distill-start')?.addEventListener('click', () => {
        handlers.onRunStyleDistill?.({ incremental: false });
    });
    bodyEl.querySelector('#tt-novel-wb-distill-refine')?.addEventListener('click', () => {
        handlers.onRunStyleDistill?.({ incremental: true });
    });
    bodyEl.querySelector('#tt-novel-wb-compress-style')?.addEventListener('click', () => {
        handlers.onCompressStyleCard?.();
    });
    bodyEl.querySelector('#tt-novel-wb-eval-style')?.addEventListener('click', () => {
        handlers.onRunStyleDistill?.({ incremental: true, evaluateOnly: true });
    });
    bodyEl.querySelector('#tt-novel-wb-save-style')?.addEventListener('click', async () => {
        const cardText = String(bodyEl.querySelector('#tt-novel-wb-style-editor')?.value || '').trim();
        const excerptsText = String(bodyEl.querySelector('#tt-novel-wb-excerpts-editor')?.value || '').trim();
        const cur = await loadLedger();
        if (!cardText) {
            cur.styleProfile = null;
        } else {
            cur.styleProfile = {
                ...(cur.styleProfile || { version: 3, fingerprintText: '', diffFindings: '', roundHistory: [], processLog: [] }),
                styleCard: cardText,
                goldenExcerpts: excerptsText,
                distilledAt: Date.now(),
            };
        }
        await saveLedger(cur);
        await refreshReaderWidgets();
        globalThis.toastr?.success?.(cardText ? '已保存文风卡' : '已清空文风卡', '小说工作台');
    });
    bodyEl.querySelector('#tt-novel-wb-clear-style')?.addEventListener('click', async () => {
        const cur = await loadLedger();
        cur.styleProfile = null;
        await saveLedger(cur);
        await refreshReaderWidgets();
        globalThis.toastr?.info?.('已清空文风卡', '小说工作台');
    });
}

function renderRewriteSubView(bodyEl, segHtml) {
    const settings = handlers.getSettings?.() || {};
    const meta = handlers.getRuntimeMeta?.() || {};
    const status = handlers.getLatestClicheStatus?.() || { hasContinuedFloor: false, report: null };
    const task = liveTaskState.cliche;
    const report = status.report;
    const lastRewrite = cachedLedger?.latestRewriteReport || null;

    const rewriteMode = ['bg', 'tavern_override', 'custom'].includes(settings.rewriteModelMode)
        ? settings.rewriteModelMode
        : 'bg';
    const tavernModels = Array.isArray(meta.tavernModels) ? meta.tavernModels : [];
    const savedRewriteTavernModel = String(settings.rewriteTavernModel || '');
    const rewriteCustomModels = Array.isArray(settings.rewriteCustomApiModelsCache) ? settings.rewriteCustomApiModelsCache : [];
    const savedRewriteCustomModel = String(settings.rewriteCustomApiModel || '');

    const progressHtml = renderTaskProgressBanner('cliche', task);

    let rewriteModelConfigHtml = `<div class="tt-novel-muted">当前跟随默认后台设置：<code>${escapeHtml(meta.activeModel || '当前酒馆模型')}</code></div>`;
    if (rewriteMode === 'tavern_override') {
        const selectHtml = tavernModels.length > 0
            ? `
                <select id="tt-novel-rw-tavern-select" class="text_pole">
                    <option value="">从已拉取列表速选（${tavernModels.length}）</option>
                    ${tavernModels.map(m => `<option value="${escapeHtml(m)}" ${m === savedRewriteTavernModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
                </select>
            `
            : '';
        rewriteModelConfigHtml = `
            <div class="tt-novel-edit-grid">
                <label>重塑专用模型名（复用当前酒馆地址与密钥）
                    <input type="text" id="tt-novel-rw-tavern-model" class="text_pole" placeholder="例如 gemini-2.5-pro" value="${escapeHtml(savedRewriteTavernModel)}" />
                </label>
                ${selectHtml}
            </div>
        `;
    } else if (rewriteMode === 'custom') {
        const customSelectHtml = rewriteCustomModels.length > 0
            ? `
                <select id="tt-novel-rw-custom-select" class="text_pole">
                    <option value="">从已拉取列表速选（${rewriteCustomModels.length}）</option>
                    ${rewriteCustomModels.map(m => `<option value="${escapeHtml(m)}" ${m === savedRewriteCustomModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
                </select>
            `
            : '';
        rewriteModelConfigHtml = `
            <div class="tt-novel-edit-grid">
                <label>Base URL（留空复用设置页地址）
                    <input type="text" id="tt-novel-rw-custom-url" class="text_pole" placeholder="${escapeHtml(settings.bgCustomApiUrl || 'https://api.example.com/v1')}" value="${escapeHtml(settings.rewriteCustomApiUrl || '')}" />
                </label>
                <label>API Key（留空继承）
                    <div class="tt-novel-bridge-row">
                        <input type="password" id="tt-novel-rw-custom-key" class="text_pole" placeholder="sk-..." value="${escapeHtml(settings.rewriteCustomApiKey || '')}" />
                        <button type="button" id="tt-novel-rw-toggle-key" class="menu_button tt-novel-btn-sm" title="显示或隐藏">${uiIcon('eye', 13)}</button>
                    </div>
                </label>
                <label>模型名称
                    <div class="tt-novel-bridge-row">
                        <input type="text" id="tt-novel-rw-custom-model" class="text_pole" placeholder="例如 claude-sonnet-4" value="${escapeHtml(savedRewriteCustomModel)}" />
                        <button type="button" id="tt-novel-rw-fetch-models" class="menu_button tt-novel-btn-sm">${uiIcon('refresh', 12)} 拉取</button>
                    </div>
                </label>
                ${customSelectHtml}
            </div>
        `;
    }

    const latestRewriteHtml = lastRewrite
        ? `
            <details class="tt-novel-accordion">
                <summary>
                    <span>第 ${lastRewrite.chapterIndex || '?'} 章重塑诊断报告</span>
                    <span class="tt-novel-chip is-ok">${lastRewrite.beforeChars || 0}→${lastRewrite.afterChars || 0}字 · 八股 ${lastRewrite.beforeCliches ?? 0}→${lastRewrite.afterCliches ?? 0}</span>
                </summary>
                <div class="tt-novel-accordion-body">
                    ${lastRewrite.driftSummary ? `
                        <div class="tt-novel-diff-box is-cool">
                            <div class="tt-novel-mini-label">初稿文风指标体检</div>
                            <div class="tt-novel-pre-wrap">${escapeHtml(lastRewrite.driftSummary)}</div>
                        </div>
                    ` : ''}
                    <div class="tt-novel-diff-box">
                        <div class="tt-novel-mini-label">诊断与执行蓝图（初稿保留在上一页 Swipe）</div>
                        <div class="tt-novel-pre-wrap">${escapeHtml(lastRewrite.diagnosisPre || '（未单独输出诊断段）')}</div>
                    </div>
                </div>
            </details>
        `
        : '';

    let summaryHtml = '<div class="tt-novel-empty">尚无已生成正文。写完章节后会自动进行 0-API 高频八股体检。</div>';
    if (status.hasContinuedFloor && report) {
        if (report.totalHits === 0) {
            summaryHtml = `<div class="tt-novel-banner is-ok">${statusDot('ok')} 第 ${status.chapterIndex} 章（楼层 #${status.floorIndex}）八股体检通过，未检出高频套话。</div>`;
        } else {
            summaryHtml = `
                <div class="tt-novel-banner is-warn">
                    ${statusDot('warn')} 第 ${status.chapterIndex} 章检出 <b>${report.totalHits}</b> 处套话：${escapeHtml(report.uniqueTerms.join('、'))}
                </div>
                <div class="tt-novel-card-stack">
                    ${report.hits.map((h, i) => `
                        <div class="tt-novel-cliche-hit">
                            <span class="tt-novel-chip is-danger">#${i + 1} ${escapeHtml(h.matchedText)}</span>
                            <span class="tt-novel-cliche-snippet">${escapeHtml(h.snippet)}</span>
                        </div>
                    `).join('')}
                </div>
            `;
        }
    }

    bodyEl.innerHTML = `
        ${segHtml}

        <section class="tt-novel-card">
            <label class="tt-novel-toggle-row">
                <input type="checkbox" id="tt-novel-rw-auto-toggle" ${settings.autoDeepRewrite ? 'checked' : ''} />
                <div>
                    <div class="tt-novel-toggle-title">写完后自动深度重塑</div>
                    <div class="tt-novel-toggle-desc">自动校验非空/非道歉后重写，初稿保留为上一页 Swipe</div>
                </div>
            </label>
            <input type="text" id="tt-novel-rw-extra" class="text_pole" placeholder="可选：临时精修要求（如压短台词、拆短长段落）..." />
            <div class="tt-novel-action-bar">
                <button type="button" id="tt-novel-deep-rewrite-now" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" ${task.running || !status.hasContinuedFloor ? 'disabled' : ''}>
                    深度重塑本章
                </button>
                <button type="button" id="tt-novel-cliche-fix" class="menu_button tt-novel-btn-sm" ${task.running || !status.hasContinuedFloor ? 'disabled' : ''}>
                    局部去八股
                </button>
                <button type="button" id="tt-novel-cliche-rescan" class="menu_button tt-novel-btn-sm">
                    重新体检
                </button>
            </div>
        </section>

        ${progressHtml}
        ${summaryHtml}
        ${latestRewriteHtml}

        <details class="tt-novel-accordion">
            <summary>
                <span>重塑专用模型通道</span>
                <span class="tt-novel-muted">${escapeHtml(meta.rewriteModelLabel || meta.activeModel || '跟随默认')}</span>
            </summary>
            <div class="tt-novel-accordion-body">
                <div class="tt-novel-edit-grid">
                    <label>模型来源
                        <select id="tt-novel-rw-mode" class="text_pole">
                            <option value="bg" ${rewriteMode === 'bg' ? 'selected' : ''}>跟随后台任务 API</option>
                            <option value="tavern_override" ${rewriteMode === 'tavern_override' ? 'selected' : ''}>复用酒馆连接 · 仅换模型名</option>
                            <option value="custom" ${rewriteMode === 'custom' ? 'selected' : ''}>独立自定义 API</option>
                        </select>
                    </label>
                    ${rewriteModelConfigHtml}
                </div>
            </div>
        </details>

        <details class="tt-novel-accordion">
            <summary>
                <span>自定义禁用词表</span>
                <span class="tt-novel-muted">内置 ${DEFAULT_CLICHE_TERMS.length} 项</span>
            </summary>
            <div class="tt-novel-accordion-body">
                <div class="tt-novel-edit-grid">
                    <label>补充禁用词（每行或逗号分隔）
                        <textarea id="tt-novel-cliche-custom" class="text_pole" rows="3" placeholder="例如：瞳孔地震、如遭雷击...">${escapeHtml(settings.clicheBlacklist || '')}</textarea>
                    </label>
                    <details class="tt-novel-subtle-fold">
                        <summary>查看内置监控词表（${DEFAULT_CLICHE_TERMS.length}）</summary>
                        <div class="tt-novel-chip-row" style="margin-top: 6px;">${DEFAULT_CLICHE_TERMS.map(t => `<span class="tt-novel-chip">${escapeHtml(t)}</span>`).join('')}</div>
                    </details>
                </div>
            </div>
        </details>
    `;

    bodyEl.querySelector('#tt-novel-rw-auto-toggle')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('autoDeepRewrite', Boolean(e.target.checked));
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rw-mode')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('rewriteModelMode', String(e.target.value || 'bg'));
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rw-tavern-model')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('rewriteTavernModel', String(e.target.value || '').trim());
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rw-tavern-select')?.addEventListener('change', (e) => {
        const picked = String(e.target.value || '').trim();
        if (!picked) return;
        handlers.onUpdateSetting?.('rewriteTavernModel', picked);
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rw-custom-url')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('rewriteCustomApiUrl', String(e.target.value || '').trim());
    });
    bodyEl.querySelector('#tt-novel-rw-custom-key')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('rewriteCustomApiKey', String(e.target.value || '').trim());
    });
    bodyEl.querySelector('#tt-novel-rw-toggle-key')?.addEventListener('click', () => {
        const keyInput = bodyEl.querySelector('#tt-novel-rw-custom-key');
        if (keyInput) keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });
    bodyEl.querySelector('#tt-novel-rw-custom-model')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('rewriteCustomApiModel', String(e.target.value || '').trim());
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rw-custom-select')?.addEventListener('change', (e) => {
        const picked = String(e.target.value || '').trim();
        if (!picked) return;
        handlers.onUpdateSetting?.('rewriteCustomApiModel', picked);
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-rw-fetch-models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const urlInput = bodyEl.querySelector('#tt-novel-rw-custom-url');
        const keyInput = bodyEl.querySelector('#tt-novel-rw-custom-key');
        if (urlInput) handlers.onUpdateSetting?.('rewriteCustomApiUrl', String(urlInput.value || '').trim());
        if (keyInput) handlers.onUpdateSetting?.('rewriteCustomApiKey', String(keyInput.value || '').trim());
        const origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = '拉取中...';
        try {
            const list = await handlers.onFetchRewriteCustomModels?.();
            if (Array.isArray(list) && list.length > 0) {
                globalThis.toastr?.success?.(`已拉取到 ${list.length} 个重塑模型`, '小说工作台');
            } else {
                globalThis.toastr?.warning?.('接口已连上，但未返回模型列表，可直接手填模型名', '小说工作台');
            }
        } catch (err) {
            globalThis.toastr?.error?.(`拉取重塑模型失败：${err?.message || err}`, '小说工作台');
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    });

    bodyEl.querySelector('#tt-novel-deep-rewrite-now')?.addEventListener('click', () => {
        const extraDirective = String(bodyEl.querySelector('#tt-novel-rw-extra')?.value || '').trim();
        handlers.onRunDeepRewriteLatest?.({ extraDirective });
    });
    bodyEl.querySelector('#tt-novel-cliche-rescan')?.addEventListener('click', () => {
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-cliche-fix')?.addEventListener('click', () => {
        handlers.onRunDeclicheLatest?.();
    });
    bodyEl.querySelector('#tt-novel-cliche-custom')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('clicheBlacklist', String(e.target.value || ''));
        renderWorkbench();
    });
}

/* ==========================================================================
   TAB 4: 目录 (Clean Unified TOC & Cutoff Manager)
   ========================================================================== */
function renderTocTab(bodyEl) {
    const chat = getContext()?.chat || [];
    const novel = cachedNovelData;

    const originalFloorByChapter = new Map();
    let lastOrigFloorIdx = -1;
    chat.forEach((msg, floorIdx) => {
        if (msg?.extra?.novelContinuationOrigin === 'original') {
            lastOrigFloorIdx = floorIdx;
            const origIdx = Number(msg.extra?.novelChapterIndex);
            if (origIdx > 0) originalFloorByChapter.set(origIdx, floorIdx);
        }
    });

    const aiFloors = [];
    chat.forEach((msg, floorIdx) => {
        if (!isContinuedNovelFloor(msg, floorIdx, lastOrigFloorIdx)) return;
        const cleanBody = stripNonStoryBlocks(String(msg.mes || '')).replace(/<\/?game>/gi, '').trim();
        const firstLine = cleanBody.split('\n').map(l => l.trim()).find(Boolean) || '正文篇章';
        const cleanHeading = firstLine.replace(/^#+\s*/, '').slice(0, 38);
        aiFloors.push({
            floorIdx,
            title: cleanHeading,
            swipeCount: Array.isArray(msg.swipes) ? msg.swipes.length : 1,
            wordCount: cleanBody.replace(/\s+/g, '').length,
        });
    });

    const addChapterHtml = addingChapterOpen
        ? `
        <div class="tt-novel-card is-editing">
            <div class="tt-novel-section-title">新增原著章节</div>
            <div class="tt-novel-edit-grid">
                <div class="tt-novel-row-2">
                    <input type="text" id="tt-novel-newch-title" class="text_pole" placeholder="章节标题" />
                    <select id="tt-novel-newch-role" class="text_pole">
                        <option value="main">主线章节</option>
                        <option value="reference">基准时间线</option>
                        <option value="flashback">倒叙/插叙</option>
                        <option value="skip">跳过</option>
                    </select>
                </div>
                <textarea id="tt-novel-newch-content" class="text_pole" rows="5" placeholder="粘贴或输入章节正文..."></textarea>
            </div>
            <div class="tt-novel-card-actions">
                <button type="button" id="tt-novel-newch-save" class="menu_button tt-novel-btn-sm tt-novel-btn-primary">保存章节</button>
                <button type="button" id="tt-novel-newch-cancel" class="menu_button tt-novel-btn-sm">取消</button>
            </div>
        </div>
        `
        : '';

    const bulkToolsHtml = novel?.chapters?.length
        ? `
        <details class="tt-novel-subtle-fold">
            <summary>按章号区间批量标注 / 删除</summary>
            <div class="tt-novel-edit-grid" style="margin-top: 8px;">
                <input type="text" id="tt-novel-toc-bulk-range" class="text_pole" value="${escapeHtml(tocBulkRangeText)}" placeholder="输入章号区间，如 78-135 或 10, 22-25" />
                <div class="tt-novel-action-bar">
                    <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-bulk-action="mark_reference">设为基准线</button>
                    <button type="button" class="menu_button tt-novel-btn-sm" data-bulk-action="mark_main">设为主线</button>
                    <button type="button" class="menu_button tt-novel-btn-sm" data-bulk-action="mark_flashback">设为倒叙</button>
                    <button type="button" class="menu_button tt-novel-btn-sm" data-bulk-action="mark_skip">设为跳过</button>
                    <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-stop" data-bulk-action="delete">批量删除</button>
                </div>
            </div>
        </details>
        `
        : '';

    bodyEl.innerHTML = `
        <div class="tt-novel-toc-jumps">
            ${novel?.chapters?.length ? '<button type="button" id="tt-novel-jump-cutoff" class="tt-novel-jump-btn">断更锚点</button>' : ''}
            <button type="button" id="tt-novel-jump-latest" class="tt-novel-jump-btn">最新章</button>
            <button type="button" id="tt-novel-jump-saved" class="tt-novel-jump-btn">上次阅读</button>
            <button type="button" id="tt-novel-toc-add-ch" class="tt-novel-jump-btn">${uiIcon('plus', 12)} 新增章</button>
        </div>
        ${addChapterHtml}
        <input type="search" id="tt-novel-toc-search" class="text_pole" placeholder="搜索章节标题或正文关键词..." />
        ${bulkToolsHtml}
        <div id="tt-novel-toc-list" class="tt-novel-toc-list-inline"></div>
    `;

    const paintList = (filterText = '') => {
        const listEl = bodyEl.querySelector('#tt-novel-toc-list');
        if (!listEl) return;
        const q = filterText.trim().toLowerCase();
        const rows = [];

        if (novel?.chapters?.length) {
            const cutoff = novel.cutoffChapterIndex || novel.totalChapters;
            const refCount = novel.chapters.filter(c => c.timelineRole === 'reference').length;
            const fbCount = novel.chapters.filter(c => c.timelineRole === 'flashback').length;
            const skipCount = novel.chapters.filter(c => c.timelineRole === 'skip').length;
            const extraMeta = `${refCount > 0 ? ` · ${refCount}基准` : ''}${fbCount > 0 ? ` · ${fbCount}倒叙` : ''}${skipCount > 0 ? ` · ${skipCount}跳过` : ''}`;
            rows.push(`<div class="tt-novel-toc-divider">原著章节（${novel.totalChapters} 章 · 锚点 #${cutoff}${extraMeta}）</div>`);
            let visible = novel.chapters;
            if (q) {
                const titleHits = novel.chapters.filter(ch => ch.title.toLowerCase().includes(q));
                visible = (titleHits.length >= 20 || q.length < 2)
                    ? titleHits
                    : novel.chapters.filter(ch => ch.title.toLowerCase().includes(q) || ch.content.toLowerCase().includes(q)).slice(0, 80);
            } else if (!showAllOriginalChapters && novel.chapters.length > TOC_PAGE_LIMIT) {
                const half = Math.floor(TOC_PAGE_LIMIT / 2);
                const start = Math.max(0, Math.min(novel.chapters.length - TOC_PAGE_LIMIT, cutoff - half));
                visible = novel.chapters.slice(start, start + TOC_PAGE_LIMIT);
                rows.push(`<button type="button" id="tt-novel-toc-show-all" class="tt-novel-jump-btn">展开全部 ${novel.chapters.length} 章</button>`);
            }
            for (const ch of visible) {
                if (editingChapterIndex === ch.index) {
                    rows.push(`
                        <div class="tt-novel-card is-editing" data-edit-ch="${ch.index}">
                            <div class="tt-novel-edit-grid">
                                <div class="tt-novel-row-2">
                                    <input type="text" class="text_pole" data-field="title" value="${escapeHtml(ch.title)}" placeholder="章节标题" />
                                    <select class="text_pole" data-field="timelineRole">
                                        <option value="main" ${ch.timelineRole !== 'reference' && ch.timelineRole !== 'flashback' && ch.timelineRole !== 'skip' ? 'selected' : ''}>主线章节</option>
                                        <option value="reference" ${ch.timelineRole === 'reference' ? 'selected' : ''}>基准时间线</option>
                                        <option value="flashback" ${ch.timelineRole === 'flashback' ? 'selected' : ''}>倒叙/插叙</option>
                                        <option value="skip" ${ch.timelineRole === 'skip' ? 'selected' : ''}>跳过</option>
                                    </select>
                                </div>
                                <textarea class="text_pole" rows="6" data-field="content">${escapeHtml(ch.content || '')}</textarea>
                            </div>
                            <div class="tt-novel-card-actions">
                                <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="save-orig-ch" data-orig-index="${ch.index}">保存</button>
                                <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-orig-ch">取消</button>
                            </div>
                        </div>
                    `);
                    continue;
                }
                const mountedFloor = originalFloorByChapter.get(ch.index);
                const isCutoff = ch.index === cutoff;
                const isAfter = ch.index > cutoff;
                const role = ch.timelineRole || 'main';
                const tagClass = isAfter ? 'masked' : (isCutoff ? 'cutoff' : 'orig');
                const tagText = isAfter ? '屏蔽' : (isCutoff ? '锚点' : `#${ch.index}`);
                const roleChip = role === 'reference'
                    ? '<span class="tt-novel-chip is-ok">基准</span>'
                    : (role === 'flashback'
                        ? '<span class="tt-novel-chip is-warn">倒叙</span>'
                        : (role === 'skip' ? '<span class="tt-novel-chip is-danger">跳过</span>' : ''));
                rows.push(`
                    <div class="tt-novel-toc-item ${isCutoff ? 'is-cutoff' : ''} ${isAfter ? 'is-masked' : ''}">
                        <div class="tt-novel-toc-item-main" data-action="view-orig" data-orig-index="${ch.index}">
                            <span class="tt-novel-toc-tag ${tagClass}">${tagText}</span>
                            ${roleChip}
                            <span class="tt-novel-toc-name">${escapeHtml(ch.title)}</span>
                            <span class="tt-novel-toc-meta">${mountedFloor !== undefined ? `#${mountedFloor}` : `${ch.wordCount}字`}</span>
                        </div>
                        <div class="tt-novel-toc-actions">
                            <button type="button" class="tt-novel-view-btn" data-action="view-orig" data-orig-index="${ch.index}">阅读</button>
                            <button type="button" class="tt-novel-cutoff-btn" data-action="cutoff-here" data-orig-index="${ch.index}">截断</button>
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-orig-ch" data-orig-index="${ch.index}" title="编辑">${uiIcon('edit', 12)}</button>
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="del-orig-ch" data-orig-index="${ch.index}" title="删除">${uiIcon('trash', 12)}</button>
                        </div>
                    </div>
                `);
            }
        }

        const aiSectionLabel = novel?.chapters?.length ? 'AI 续写章节' : '已创作章节';
        rows.push(`<div class="tt-novel-toc-divider">${aiSectionLabel}（${aiFloors.length} 章）</div>`);
        if (aiFloors.length === 0) {
            rows.push('<div class="tt-novel-empty">尚无创作章节，在「创作」页生成大纲后点击开写即可。</div>');
        } else {
            aiFloors.forEach((item, idx) => {
                if (q && !item.title.toLowerCase().includes(q)) return;
                rows.push(`
                    <div class="tt-novel-toc-item is-ai" data-action="jump-floor" data-floor="${item.floorIdx}">
                        <div class="tt-novel-toc-item-main">
                            <span class="tt-novel-toc-tag ai">第 ${idx + 1} 章</span>
                            <span class="tt-novel-toc-name">${escapeHtml(item.title)}</span>
                            <span class="tt-novel-toc-meta">${item.wordCount}字 · #${item.floorIdx}</span>
                        </div>
                    </div>
                `);
            });
        }

        listEl.innerHTML = rows.join('');

        listEl.querySelector('#tt-novel-toc-show-all')?.addEventListener('click', () => {
            showAllOriginalChapters = true;
            paintList(q);
        });
        listEl.querySelectorAll('[data-action="jump-floor"]').forEach(el => {
            el.addEventListener('click', async () => {
                const floor = Number(el.getAttribute('data-floor'));
                closeWorkbench();
                await scrollToChatFloor(floor);
            });
        });
        listEl.querySelectorAll('[data-action="view-orig"]').forEach(el => {
            el.addEventListener('click', async () => {
                const idx = Number(el.getAttribute('data-orig-index'));
                closeWorkbench();
                const mounted = originalFloorByChapter.get(idx);
                if (mounted !== undefined) {
                    if (cachedNovelData) cachedNovelData.viewingChapterIndex = idx;
                    await scrollToChatFloor(mounted);
                } else {
                    await handlers.onViewChapter?.(idx);
                }
            });
        });
        listEl.querySelectorAll('[data-action="cutoff-here"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const idx = Number(btn.getAttribute('data-orig-index'));
                closeWorkbench();
                await handlers.onCutoffFromChapter?.(idx);
                await refreshReaderWidgets();
            });
        });
        listEl.querySelectorAll('[data-action="edit-orig-ch"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                editingChapterIndex = Number(btn.getAttribute('data-orig-index'));
                paintList(q);
            });
        });
        listEl.querySelectorAll('[data-action="cancel-orig-ch"]').forEach(btn => {
            btn.addEventListener('click', () => {
                editingChapterIndex = null;
                paintList(q);
            });
        });
        listEl.querySelectorAll('[data-action="save-orig-ch"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const idx = Number(btn.getAttribute('data-orig-index'));
                const card = listEl.querySelector(`[data-edit-ch="${idx}"]`);
                if (!card) return;
                const title = String(card.querySelector('[data-field="title"]')?.value || '').trim();
                const timelineRole = String(card.querySelector('[data-field="timelineRole"]')?.value || 'main');
                const content = String(card.querySelector('[data-field="content"]')?.value || '').trim();
                editingChapterIndex = null;
                await handlers.onEditOriginalChapter?.(idx, { title, timelineRole, content });
            });
        });
        listEl.querySelectorAll('[data-action="del-orig-ch"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const idx = Number(btn.getAttribute('data-orig-index'));
                if (!window.confirm(`确定删除原著第 ${idx} 章吗？删除后后续章号将自动重排。`)) return;
                await handlers.onDeleteOriginalChapter?.(idx);
            });
        });
    };

    paintList('');

    bodyEl.querySelector('#tt-novel-toc-add-ch')?.addEventListener('click', () => {
        addingChapterOpen = !addingChapterOpen;
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-newch-cancel')?.addEventListener('click', () => {
        addingChapterOpen = false;
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-newch-save')?.addEventListener('click', async () => {
        const title = String(bodyEl.querySelector('#tt-novel-newch-title')?.value || '').trim();
        const timelineRole = String(bodyEl.querySelector('#tt-novel-newch-role')?.value || 'main');
        const content = String(bodyEl.querySelector('#tt-novel-newch-content')?.value || '').trim();
        if (!content) {
            globalThis.toastr?.warning?.('请输入章节正文', '小说工作台');
            return;
        }
        addingChapterOpen = false;
        await handlers.onAddOriginalChapter?.({ title, timelineRole, content });
    });

    const bulkInput = bodyEl.querySelector('#tt-novel-toc-bulk-range');
    bulkInput?.addEventListener('input', (e) => {
        tocBulkRangeText = String(e.target.value || '');
    });
    bodyEl.querySelectorAll('[data-bulk-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.getAttribute('data-bulk-action');
            const rangeText = String(bulkInput?.value || '').trim();
            tocBulkRangeText = rangeText;
            if (!rangeText) {
                globalThis.toastr?.warning?.('请先输入章号区间（例如 78-135）', '小说工作台');
                return;
            }
            if (action === 'delete' && !window.confirm(`确定批量删除区间 [${rangeText}] 的章节吗？此操作不可撤销。`)) {
                return;
            }
            await handlers.onBulkUpdateOriginalChapters?.({ rangeText, action });
        });
    });

    bodyEl.querySelector('#tt-novel-toc-search')?.addEventListener('input', debounce((e) => {
        paintList(String(e.target.value || ''));
    }, 220));
    bodyEl.querySelector('#tt-novel-jump-cutoff')?.addEventListener('click', async () => {
        closeWorkbench();
        if (cachedNovelData) await handlers.onViewChapter?.(cachedNovelData.cutoffChapterIndex || cachedNovelData.totalChapters);
        else await jumpToCutoffBoundary();
    });
    bodyEl.querySelector('#tt-novel-jump-latest')?.addEventListener('click', async () => {
        closeWorkbench();
        await jumpToLatestFloor();
    });
    bodyEl.querySelector('#tt-novel-jump-saved')?.addEventListener('click', async () => {
        closeWorkbench();
        await jumpToSavedProgress();
    });
}

/* ==========================================================================
   TAB 5: 设置 (4 Core Toggles + 4 Clean Single-Level Accordions)
   ========================================================================== */
function renderSettingsTab(bodyEl) {
    const settings = handlers.getSettings?.() || {};
    const meta = handlers.getRuntimeMeta?.() || {};
    const nCfg = normalizeNarrativeConfig(cachedLedger?.narrativeConfig);
    const canonCount = cachedCanonDb?.items?.length || 0;
    const canonSources = cachedCanonDb?.sources?.join(', ') || '';
    const presetNames = Array.isArray(meta.presetNames) ? meta.presetNames : [];
    const savedPreset = String(settings.distillPresetName ?? '__current__');
    const bridgeTone = lastBridgeUi.state === 'connected' ? 'ok' : (lastBridgeUi.state === 'connecting' ? 'warn' : (lastBridgeUi.state === 'error' ? 'error' : 'idle'));

    const isCustomApi = settings.bgApiMode === 'custom';
    const cachedModels = Array.isArray(settings.bgCustomApiModelsCache) ? settings.bgCustomApiModelsCache : [];
    const customModelVal = String(settings.bgCustomApiModel || '');
    const purePresetName = String(meta.bundledPurePresetName || 'TT小说续写专用-纯净版');
    const isPurePresetActive = Boolean(meta.activePresetName && meta.activePresetName === purePresetName);
    const isPurePresetInstalled = presetNames.includes(purePresetName);

    const presetOptions = [
        `<option value="__current__" ${savedPreset === '__current__' ? 'selected' : ''}>当前酒馆预设${meta.activePresetName ? `（${escapeHtml(meta.activePresetName)}）` : ''}</option>`,
        `<option value="" ${savedPreset === '' ? 'selected' : ''}>不使用预设（纯净直连）</option>`,
        ...presetNames.map(n => `<option value="${escapeHtml(n)}" ${savedPreset === n ? 'selected' : ''}>${escapeHtml(n)}</option>`),
    ];
    if (savedPreset && savedPreset !== '__current__' && !presetNames.includes(savedPreset)) {
        presetOptions.push(`<option value="${escapeHtml(savedPreset)}" selected>${escapeHtml(savedPreset)}（未找到）</option>`);
    }

    const modelOptionsHtml = cachedModels.length > 0
        ? `
            <select id="tt-novel-wb-custom-model-select" class="text_pole">
                <option value="">从已拉取列表速选（${cachedModels.length}）</option>
                ${cachedModels.map(m => `<option value="${escapeHtml(m)}" ${m === customModelVal ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
            </select>
        `
        : '';

    const povSummary = nCfg.povMode === 'strict_limited' && nCfg.povCharacter
        ? `单视角：${nCfg.povCharacter}`
        : '自动视角';
    const filesSummary = cachedNovelData?.totalChapters
        ? `原著 ${cachedNovelData.totalChapters} 章 · 设定 ${canonCount} 条`
        : `零章模式 · 设定 ${canonCount} 条`;

    bodyEl.innerHTML = `
        <section class="tt-novel-card">
            <div class="tt-novel-section-title">常用开关</div>
            <div class="tt-novel-toggle-list">
                <label class="tt-novel-toggle-row">
                    <input type="checkbox" data-setting="enabled" ${settings.enabled ? 'checked' : ''} />
                    <div>
                        <div class="tt-novel-toggle-title">启用小说插件</div>
                        <div class="tt-novel-toggle-desc">关闭后彻底还原普通酒馆聊天</div>
                    </div>
                </label>
                <label class="tt-novel-toggle-row">
                    <input type="checkbox" data-setting="immersiveMode" ${settings.immersiveMode ? 'checked' : ''} />
                    <div>
                        <div class="tt-novel-toggle-title">沉浸书页排版</div>
                        <div class="tt-novel-toggle-desc">隐藏头像与气泡，采用连续书页字体与行距</div>
                    </div>
                </label>
                <label class="tt-novel-toggle-row">
                    <input type="checkbox" data-setting="enableAutoStateBlock" ${settings.enableAutoStateBlock ? 'checked' : ''} />
                    <div>
                        <div class="tt-novel-toggle-title">每章末尾自动输出总结与伏笔</div>
                        <div class="tt-novel-toggle-desc">0 额外 API，自动沉淀单章四要素摘要与状态更新</div>
                    </div>
                </label>
                <label class="tt-novel-toggle-row">
                    <input type="checkbox" data-setting="autoDeepRewrite" ${settings.autoDeepRewrite ? 'checked' : ''} />
                    <div>
                        <div class="tt-novel-toggle-title">写完后自动深度重塑</div>
                        <div class="tt-novel-toggle-desc">自动校验空回与道歉，初稿保留为上一页 Swipe</div>
                    </div>
                </label>
            </div>
        </section>

        <details class="tt-novel-accordion" ${settingsFocusSection === 'narrative' ? 'open' : ''}>
            <summary>
                <span>叙事视角、时间线与世界书</span>
                <span class="tt-novel-muted">${escapeHtml(povSummary)}</span>
            </summary>
            <div class="tt-novel-accordion-body">
                <div class="tt-novel-edit-grid">
                    <div class="tt-novel-row-3">
                        <label>叙事视角模式
                            <select id="tt-novel-ncfg-pov-mode" class="text_pole">
                                <option value="auto" ${nCfg.povMode === 'auto' ? 'selected' : ''}>自动 / 多视角</option>
                                <option value="strict_limited" ${nCfg.povMode === 'strict_limited' ? 'selected' : ''}>严格限制单视角</option>
                            </select>
                        </label>
                        <label>锁定视角人物
                            <input type="text" id="tt-novel-ncfg-pov-char" class="text_pole" value="${escapeHtml(nCfg.povCharacter || '')}" placeholder="如：主角名" />
                        </label>
                        <label>单视角人称
                            <select id="tt-novel-ncfg-pov-person" class="text_pole">
                                <option value="follow_original" ${nCfg.povPerson === 'follow_original' ? 'selected' : ''}>跟随原著</option>
                                <option value="first_person" ${nCfg.povPerson === 'first_person' ? 'selected' : ''}>第一人称</option>
                                <option value="third_limited" ${nCfg.povPerson === 'third_limited' ? 'selected' : ''}>第三人称限知</option>
                            </select>
                        </label>
                    </div>
                    <div class="tt-novel-row-3">
                        <label>后台贯通酒馆世界书
                            <select id="tt-novel-ncfg-wi-mode" class="text_pole">
                                <option value="bridge" ${nCfg.worldInfoMode !== 'off' ? 'selected' : ''}>开启</option>
                                <option value="off" ${nCfg.worldInfoMode === 'off' ? 'selected' : ''}>关闭</option>
                            </select>
                        </label>
                        <label>设定冲突优先级
                            <select id="tt-novel-ncfg-wi-priority" class="text_pole">
                                <option value="novel_over_wi" ${nCfg.worldInfoPriority !== 'wi_strict' ? 'selected' : ''}>小说优先，世界书兜底</option>
                                <option value="wi_strict" ${nCfg.worldInfoPriority === 'wi_strict' ? 'selected' : ''}>严格遵循世界书</option>
                            </select>
                        </label>
                        <label>世界书注入预算（字）
                            <input type="number" id="tt-novel-ncfg-wi-budget" class="text_pole" min="2000" max="40000" step="1000" value="${Number(nCfg.worldInfoBudgetChars || 12000)}" />
                        </label>
                    </div>
                    <label class="tt-novel-check-row">
                        <input type="checkbox" id="tt-novel-ncfg-strict-tl" ${nCfg.strictTimelineOrder !== false ? 'checked' : ''} />
                        <span>严格单向推进时间线，禁止倒流重复已发生桥段</span>
                    </label>
                    <label class="tt-novel-check-row">
                        <input type="checkbox" id="tt-novel-ncfg-skip-fb" ${nCfg.excludeFlashbackFromAnchor !== false ? 'checked' : ''} />
                        <span>续写锚点自动跳过「倒叙/插叙」章节</span>
                    </label>
                    <details class="tt-novel-subtle-fold" ${nCfg.referenceTimelineMode ? 'open' : ''}>
                        <summary>平行视角与基准时间线对照（${nCfg.referenceTimelineMode ? `对齐 #${nCfg.referenceCursorChapter || 0}` : '未启用'}）</summary>
                        <div class="tt-novel-edit-grid" style="margin-top: 8px;">
                            <label class="tt-novel-check-row">
                                <input type="checkbox" id="tt-novel-ncfg-ref-mode" ${nCfg.referenceTimelineMode ? 'checked' : ''} />
                                <span>启用平行视角对照已完结基准时间线</span>
                            </label>
                            <div class="tt-novel-row-3">
                                <label>基准线名称
                                    <input type="text" id="tt-novel-ncfg-ref-label" class="text_pole" value="${escapeHtml(nCfg.referencePovLabel || '')}" placeholder="如：原著A线" />
                                </label>
                                <label>当前对齐章号
                                    <input type="number" id="tt-novel-ncfg-ref-cursor" class="text_pole" min="0" value="${Number(nCfg.referenceCursorChapter || 0)}" />
                                </label>
                                <label>前方路标视野
                                    <input type="number" id="tt-novel-ncfg-ref-window" class="text_pole" min="2" max="20" value="${Number(nCfg.referenceLookaheadChapters || 8)}" />
                                </label>
                            </div>
                            <label class="tt-novel-check-row">
                                <input type="checkbox" id="tt-novel-ncfg-auto-cursor" ${nCfg.autoAdvanceRefCursor !== false ? 'checked' : ''} />
                                <span>每次续写后自动推进基准章号指针</span>
                            </label>
                            <label class="tt-novel-check-row">
                                <input type="checkbox" id="tt-novel-ncfg-auto-detect" ${nCfg.autoDetectOnArchive !== false ? 'checked' : ''} />
                                <span>新书全本归档前自动识别视角与双线结构</span>
                            </label>
                        </div>
                    </details>
                    <div class="tt-novel-action-bar">
                        <button type="button" id="tt-novel-ncfg-save" class="menu_button tt-novel-btn-sm tt-novel-btn-primary">保存规则</button>
                        <button type="button" id="tt-novel-ncfg-auto-run" class="menu_button tt-novel-btn-sm">自动识别结构</button>
                    </div>
                </div>
            </div>
        </details>

        <details class="tt-novel-accordion" ${settingsFocusSection === 'model' || !isPurePresetActive ? 'open' : ''}>
            <summary>
                <span>模型接口与专用预设</span>
                <span class="tt-novel-muted">${escapeHtml(isPurePresetActive ? purePresetName : (meta.activePresetName || '未配置'))}</span>
            </summary>
            <div class="tt-novel-accordion-body">
                <div class="tt-novel-edit-grid">
                    <label>后台任务 API 来源
                        <select id="tt-novel-wb-api-mode" class="text_pole">
                            <option value="tavern" ${!isCustomApi ? 'selected' : ''}>酒馆当前 API（${escapeHtml(meta.tavernModel || '跟随连接')}）</option>
                            <option value="custom" ${isCustomApi ? 'selected' : ''}>自定义 OpenAI 兼容 API</option>
                        </select>
                    </label>
                    ${isCustomApi ? `
                        <div class="tt-novel-custom-api-box">
                            <div class="tt-novel-edit-grid">
                                <label>Base URL
                                    <input type="text" id="tt-novel-wb-custom-url" class="text_pole" placeholder="https://api.example.com/v1" value="${escapeHtml(settings.bgCustomApiUrl || '')}" />
                                </label>
                                <label>API Key
                                    <div class="tt-novel-bridge-row">
                                        <input type="password" id="tt-novel-wb-custom-key" class="text_pole" placeholder="sk-..." value="${escapeHtml(settings.bgCustomApiKey || '')}" />
                                        <button type="button" id="tt-novel-wb-toggle-key" class="menu_button tt-novel-btn-sm" title="显示或隐藏">${uiIcon('eye', 13)}</button>
                                    </div>
                                </label>
                                <label>模型名称
                                    <div class="tt-novel-bridge-row">
                                        <input type="text" id="tt-novel-wb-custom-model" class="text_pole" placeholder="例如 gemini-2.5-pro" value="${escapeHtml(customModelVal)}" />
                                        <button type="button" id="tt-novel-wb-fetch-models" class="menu_button tt-novel-btn-sm">${uiIcon('refresh', 12)} 拉取</button>
                                    </div>
                                </label>
                                ${modelOptionsHtml}
                                <div class="tt-novel-inline-field">
                                    <span>Temperature (0.0 ~ 1.5)</span>
                                    <input type="number" id="tt-novel-wb-custom-temp" class="text_pole" min="0" max="1.5" step="0.1" value="${Number(settings.bgCustomTemperature ?? 0.7)}" style="width: 78px;" />
                                </div>
                            </div>
                        </div>
                    ` : ''}
                    <label>后台任务套用预设
                        <select id="tt-novel-wb-preset-select" class="text_pole">${presetOptions.join('')}</select>
                    </label>
                    <div class="tt-novel-muted">
                        ${isPurePresetActive
                            ? `当前已启用本插件专用预设 <code>${escapeHtml(purePresetName)}</code>（无 RP 干扰、保留 &lt;novel_state&gt;、服从文风卡与单视角）。`
                            : `推荐导入插件专用预设 <code>${escapeHtml(purePresetName)}</code>${isPurePresetInstalled ? '（已在列表中）' : ''}，不会改动你的 API 连接与模型。`}
                    </div>
                    <div class="tt-novel-action-bar">
                        <button type="button" id="tt-novel-wb-install-pure-preset" class="menu_button tt-novel-btn-sm ${isPurePresetActive ? '' : 'tt-novel-btn-primary'}">
                            ${isPurePresetActive ? '重置专用预设' : '一键导入并启用预设'}
                        </button>
                        <button type="button" id="tt-novel-wb-export-pure-preset" class="menu_button tt-novel-btn-sm">
                            ${uiIcon('download', 12)} 导出 JSON
                        </button>
                    </div>
                </div>
            </div>
        </details>

        <details class="tt-novel-accordion" ${settingsFocusSection === 'files' ? 'open' : ''}>
            <summary>
                <span>作品导入、阅读细节与数据清理</span>
                <span class="tt-novel-muted">${escapeHtml(filesSummary)}</span>
            </summary>
            <div class="tt-novel-accordion-body">
                <div class="tt-novel-edit-grid">
                    <div class="tt-novel-action-bar">
                        <button type="button" id="tt-novel-wb-start-original" class="menu_button tt-novel-btn-sm tt-novel-btn-primary">新书立项</button>
                        <label class="menu_button tt-novel-btn-sm tt-novel-file-label">
                            ${uiIcon('upload', 12)} 导入原著
                            <input type="file" id="tt-novel-wb-import-txt" accept=".txt,.md,text/plain,text/markdown,*/*" hidden />
                        </label>
                        <label class="menu_button tt-novel-btn-sm tt-novel-file-label">
                            ${uiIcon('upload', 12)} 挂载设定库
                            <input type="file" id="tt-novel-wb-import-canon" accept=".json,.jsonl,.md,.txt,application/json,text/plain,*/*" multiple hidden />
                        </label>
                    </div>
                    ${canonSources ? `<div class="tt-novel-muted">已挂载来源：${escapeHtml(canonSources)}</div>` : ''}
                    <div class="tt-novel-inline-field">
                        <span>续写直喂末尾原著章数 (1~20)</span>
                        <input type="number" id="tt-novel-wb-anchor-count" class="text_pole" min="1" max="20" value="${Number(settings.mountAnchorChapters || 3)}" style="width: 72px;" />
                    </div>
                    <div class="tt-novel-toggle-list">
                        <label class="tt-novel-check-row"><input type="checkbox" data-setting="hideUserFloors" ${settings.hideUserFloors ? 'checked' : ''} /><span>隐藏所有用户指令楼层</span></label>
                        <label class="tt-novel-check-row"><input type="checkbox" data-setting="hideReasoning" ${settings.hideReasoning !== false ? 'checked' : ''} /><span>隐藏 AI 思维链与思考框</span></label>
                        <label class="tt-novel-check-row"><input type="checkbox" data-setting="authorMode" ${settings.authorMode !== false ? 'checked' : ''} /><span>作者模式（屏蔽玩家人设，输入转为导演指令）</span></label>
                        <label class="tt-novel-check-row"><input type="checkbox" data-setting="foldUserOutlineFloors" ${settings.foldUserOutlineFloors !== false ? 'checked' : ''} /><span>写完后自动折叠用户大纲楼层</span></label>
                        <label class="tt-novel-check-row"><input type="checkbox" data-setting="autoFallbackChapterSummary" ${settings.autoFallbackChapterSummary !== false ? 'checked' : ''} /><span>漏掉单章总结时自动后台补做</span></label>
                        <label class="tt-novel-check-row"><input type="checkbox" data-setting="syncToWorldInfo" ${settings.syncToWorldInfo ? 'checked' : ''} /><span>提取状态同步写入酒馆世界书</span></label>
                    </div>
                    <div class="tt-novel-action-bar">
                        <button type="button" id="tt-novel-wb-clear-canon" class="menu_button tt-novel-btn-sm">清空设定库</button>
                        <button type="button" id="tt-novel-wb-clear-all" class="menu_button tt-novel-btn-sm tt-novel-btn-stop">重置当前对话数据</button>
                    </div>
                </div>
            </div>
        </details>

        <details class="tt-novel-accordion" ${settingsFocusSection === 'bridge' ? 'open' : ''}>
            <summary>
                <span>远程 Agent 开发桥</span>
                <span class="tt-novel-muted">${statusDot(bridgeTone)} ${lastBridgeUi.state === 'connected' ? '已连接' : '未连接'}</span>
            </summary>
            <div class="tt-novel-accordion-body">
                <div class="tt-novel-bridge-row">
                    <input type="text" id="tt-novel-wb-bridge-url" class="text_pole" placeholder="ws://局域网IP:17890/ws" value="${escapeHtml(settings.remoteBridgeUrl || '')}" />
                    <button type="button" id="tt-novel-wb-bridge-conn" class="menu_button tt-novel-btn-sm">连接</button>
                    <button type="button" id="tt-novel-wb-bridge-disc" class="menu_button tt-novel-btn-sm">断开</button>
                </div>
                <small id="tt-novel-bridge-status" class="tt-novel-bridge-status">${statusDot(bridgeTone)} ${escapeHtml(lastBridgeUi.detail)}</small>
            </div>
        </details>
    `;

    bodyEl.querySelector('#tt-novel-ncfg-save')?.addEventListener('click', async () => {
        const patch = {
            povMode: String(bodyEl.querySelector('#tt-novel-ncfg-pov-mode')?.value || 'auto'),
            povCharacter: String(bodyEl.querySelector('#tt-novel-ncfg-pov-char')?.value || '').trim(),
            povPerson: String(bodyEl.querySelector('#tt-novel-ncfg-pov-person')?.value || 'follow_original'),
            worldInfoMode: String(bodyEl.querySelector('#tt-novel-ncfg-wi-mode')?.value || 'bridge'),
            worldInfoPriority: String(bodyEl.querySelector('#tt-novel-ncfg-wi-priority')?.value || 'novel_over_wi'),
            worldInfoBudgetChars: Number(bodyEl.querySelector('#tt-novel-ncfg-wi-budget')?.value || 12000),
            strictTimelineOrder: Boolean(bodyEl.querySelector('#tt-novel-ncfg-strict-tl')?.checked),
            excludeFlashbackFromAnchor: Boolean(bodyEl.querySelector('#tt-novel-ncfg-skip-fb')?.checked),
            referenceTimelineMode: Boolean(bodyEl.querySelector('#tt-novel-ncfg-ref-mode')?.checked),
            referencePovLabel: String(bodyEl.querySelector('#tt-novel-ncfg-ref-label')?.value || '').trim(),
            referenceCursorChapter: Number(bodyEl.querySelector('#tt-novel-ncfg-ref-cursor')?.value || 0),
            referenceLookaheadChapters: Number(bodyEl.querySelector('#tt-novel-ncfg-ref-window')?.value || 8),
            autoAdvanceRefCursor: Boolean(bodyEl.querySelector('#tt-novel-ncfg-auto-cursor')?.checked),
            autoDetectOnArchive: Boolean(bodyEl.querySelector('#tt-novel-ncfg-auto-detect')?.checked),
        };
        if (patch.povMode === 'strict_limited' && !patch.povCharacter) {
            globalThis.toastr?.warning?.('已选严格限制单视角，请填写锁定视角人物名称', '小说工作台');
            return;
        }
        await handlers.onUpdateNarrativeConfig?.(patch);
        globalThis.toastr?.success?.('已保存叙事视角与世界书规则', '小说工作台');
    });
    bodyEl.querySelector('#tt-novel-ncfg-auto-run')?.addEventListener('click', () => {
        activeTab = 'memory';
        renderWorkbench();
        handlers.onAutoDetectNarrativeStructure?.();
    });

    bodyEl.querySelector('#tt-novel-wb-start-original')?.addEventListener('click', () => {
        void openWorkbench('blueprint');
    });
    bodyEl.querySelector('#tt-novel-wb-import-txt')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (file) await handlers.onImportNovelFile?.(file);
        e.target.value = '';
    });
    bodyEl.querySelector('#tt-novel-wb-import-canon')?.addEventListener('change', async (e) => {
        const files = [...(e.target.files || [])];
        if (files.length > 0) await handlers.onImportCanonFiles?.(files);
        e.target.value = '';
    });
    bodyEl.querySelector('#tt-novel-wb-clear-canon')?.addEventListener('click', () => handlers.onClearCanon?.());
    bodyEl.querySelector('#tt-novel-wb-clear-all')?.addEventListener('click', () => handlers.onClearAll?.());

    bodyEl.querySelector('#tt-novel-wb-api-mode')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('bgApiMode', e.target.value === 'custom' ? 'custom' : 'tavern');
        settingsFocusSection = 'model';
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-wb-custom-url')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('bgCustomApiUrl', String(e.target.value || '').trim());
    });
    bodyEl.querySelector('#tt-novel-wb-custom-key')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('bgCustomApiKey', String(e.target.value || '').trim());
    });
    bodyEl.querySelector('#tt-novel-wb-toggle-key')?.addEventListener('click', () => {
        const keyInput = bodyEl.querySelector('#tt-novel-wb-custom-key');
        if (keyInput) keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });
    bodyEl.querySelector('#tt-novel-wb-custom-model')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('bgCustomApiModel', String(e.target.value || '').trim());
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-wb-custom-model-select')?.addEventListener('change', (e) => {
        const picked = String(e.target.value || '').trim();
        if (!picked) return;
        handlers.onUpdateSetting?.('bgCustomApiModel', picked);
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-wb-custom-temp')?.addEventListener('change', (e) => {
        const t = Math.max(0, Math.min(1.5, Number(e.target.value)));
        handlers.onUpdateSetting?.('bgCustomTemperature', Number.isFinite(t) ? t : 0.7);
    });
    bodyEl.querySelector('#tt-novel-wb-fetch-models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const urlInput = bodyEl.querySelector('#tt-novel-wb-custom-url');
        const keyInput = bodyEl.querySelector('#tt-novel-wb-custom-key');
        if (urlInput) handlers.onUpdateSetting?.('bgCustomApiUrl', String(urlInput.value || '').trim());
        if (keyInput) handlers.onUpdateSetting?.('bgCustomApiKey', String(keyInput.value || '').trim());
        const origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = '拉取中...';
        try {
            const list = await handlers.onFetchCustomModels?.();
            if (Array.isArray(list) && list.length > 0) {
                globalThis.toastr?.success?.(`已拉取到 ${list.length} 个模型`, '小说工作台');
            } else {
                globalThis.toastr?.warning?.('接口已连上，但未返回模型列表，可直接手填模型名', '小说工作台');
            }
        } catch (err) {
            globalThis.toastr?.error?.(`拉取模型失败：${err?.message || err}`, '小说工作台');
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    });

    bodyEl.querySelector('#tt-novel-wb-preset-select')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('distillPresetName', String(e.target.value ?? ''));
        renderWorkbench();
    });
    bodyEl.querySelector('#tt-novel-wb-install-pure-preset')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '正在导入...';
        try {
            await handlers.onInstallBundledPurePreset?.();
        } catch (err) {
            globalThis.toastr?.error?.(`导入预设失败：${err?.message || err}`, '小说工作台');
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    });
    bodyEl.querySelector('#tt-novel-wb-export-pure-preset')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = '导出中...';
        try {
            await handlers.onExportBundledPurePreset?.();
        } catch (err) {
            globalThis.toastr?.error?.(`导出预设失败：${err?.message || err}`, '小说工作台');
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    });
    bodyEl.querySelector('#tt-novel-wb-anchor-count')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('mountAnchorChapters', Math.max(1, Math.min(20, Number(e.target.value) || 3)));
    });
    bodyEl.querySelectorAll('input[data-setting]').forEach(chk => {
        chk.addEventListener('change', (e) => {
            const key = chk.getAttribute('data-setting');
            handlers.onUpdateSetting?.(key, Boolean(e.target.checked));
        });
    });

    bodyEl.querySelector('#tt-novel-wb-bridge-conn')?.addEventListener('click', () => {
        const url = String(bodyEl.querySelector('#tt-novel-wb-bridge-url')?.value || '').trim();
        handlers.onConnectBridge?.(url);
    });
    bodyEl.querySelector('#tt-novel-wb-bridge-disc')?.addEventListener('click', () => {
        handlers.onDisconnectBridge?.();
    });
}

/* ==========================================================================
   Scroll, Floor Jump & Reading Progress Helpers
   ========================================================================== */
function getCurrentVisibleOriginalChapterIndex() {
    const chatEl = document.getElementById('chat');
    const chat = getContext()?.chat;
    if (!chatEl || !Array.isArray(chat)) return null;

    const rect = chatEl.getBoundingClientRect();
    const probeY = rect.top + Math.min(140, rect.height * 0.25);
    const blocks = chatEl.querySelectorAll('.mes:not([is_user="true"])');
    for (const block of blocks) {
        const bRect = block.getBoundingClientRect();
        if (bRect.top <= probeY && bRect.bottom >= rect.top + 8) {
            const mesId = Number(block.getAttribute('mesid'));
            const origIdx = Number(chat[mesId]?.extra?.novelChapterIndex);
            if (origIdx > 0) return origIdx;
        }
    }
    return null;
}

export async function scrollToChatFloor(floorIndex) {
    const chatEl = document.getElementById('chat');
    if (!chatEl || !Number.isFinite(floorIndex) || floorIndex < 0) return;

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    let targetMes = chatEl.querySelector(`.mes[mesid="${floorIndex}"]`);
    if (!targetMes && typeof isBoundedChatSurfaceView === 'function' && isBoundedChatSurfaceView()) {
        try {
            targetMes = jumpBoundedChatSurfaceToMessage(floorIndex);
        } catch (err) {
            console.warn('[小说工作台] BoundedChatSurface 跳转楼层失败：', err);
        }
    }

    let guard = 0;
    while (!chatEl.querySelector(`.mes[mesid="${floorIndex}"]`) && guard < 25) {
        const showMoreBtn = document.getElementById('show_more_messages');
        if (!showMoreBtn) break;
        showMoreBtn.click();
        guard += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
    }

    const context = getContext();
    if (!chatEl.querySelector(`.mes[mesid="${floorIndex}"]`) && Array.isArray(context?.chat) && floorIndex < context.chat.length) {
        try {
            resetChatSurfaceView?.({ includeAuxiliary: true });
            await context.printMessages?.();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        } catch (err) {
            console.warn('[小说工作台] 自愈重绘聊天楼层失败：', err);
        }
    }

    const alignFloor = () => {
        const mes = chatEl.querySelector(`.mes[mesid="${floorIndex}"]`) || targetMes;
        if (!mes) return false;
        const chatRect = chatEl.getBoundingClientRect();
        const mesRect = mes.getBoundingClientRect();
        chatEl.scrollTop = Math.max(0, chatEl.scrollTop + (mesRect.top - chatRect.top) - 8);
        mes.classList.add('tt-novel-flash-highlight');
        setTimeout(() => mes.classList.remove('tt-novel-flash-highlight'), 1600);
        saveReadingProgress(floorIndex);
        return true;
    };

    alignFloor();
    setTimeout(() => alignFloor(), 240);
}

async function jumpToCutoffBoundary() {
    const chat = getContext()?.chat || [];
    let lastOrigFloor = -1;
    chat.forEach((msg, idx) => {
        if (msg?.extra?.novelContinuationOrigin === 'original') {
            lastOrigFloor = idx;
        }
    });
    if (lastOrigFloor >= 0) await scrollToChatFloor(lastOrigFloor);
    else if (chat.length > 0) await scrollToChatFloor(0);
}

async function jumpToLatestFloor() {
    const chat = getContext()?.chat || [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (!chat[i]?.is_user) {
            await scrollToChatFloor(i);
            return;
        }
    }
}

async function jumpToSavedProgress() {
    const chat = getContext()?.chat || [];
    const progress = getContext()?.chatMetadata?.[PROGRESS_META_KEY];
    if (progress && Number.isFinite(progress.floorIndex) && progress.floorIndex < chat.length) {
        await scrollToChatFloor(progress.floorIndex);
    } else {
        await jumpToCutoffBoundary();
    }
}

export function clearReadingProgress() {
    const context = getContext();
    if (!context?.chatMetadata) return;
    delete context.chatMetadata[PROGRESS_META_KEY];
    context.saveMetadataDebounced?.();
}

function saveReadingProgress(floorIndex) {
    const context = getContext();
    if (!context?.chatMetadata) return;
    context.chatMetadata[PROGRESS_META_KEY] = {
        floorIndex,
        updatedAt: Date.now(),
    };
    context.saveMetadataDebounced?.();
}

function installScrollProgressTracker() {
    const chatEl = document.getElementById('chat');
    if (!chatEl || chatEl.dataset.ttNovelScrollBound === '1') return;
    chatEl.dataset.ttNovelScrollBound = '1';

    const onScrollDebounced = debounce(() => {
        const rect = chatEl.getBoundingClientRect();
        const midY = rect.top + rect.height * 0.35;
        const blocks = chatEl.querySelectorAll('.mes:not([is_user="true"])');
        const chat = getContext()?.chat || [];
        for (const block of blocks) {
            const bRect = block.getBoundingClientRect();
            if (bRect.top <= midY && bRect.bottom >= rect.top) {
                const mesId = Number(block.getAttribute('mesid'));
                if (Number.isFinite(mesId)) {
                    saveReadingProgress(mesId);
                    const origIdx = Number(chat[mesId]?.extra?.novelChapterIndex);
                    if (origIdx > 0 && cachedNovelData) {
                        cachedNovelData.viewingChapterIndex = origIdx;
                    }
                }
                break;
            }
        }
    }, 600);

    chatEl.addEventListener('scroll', onScrollDebounced, { passive: true });
}
