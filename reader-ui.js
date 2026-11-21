import { escapeHtml, debounce } from '/scripts/utils.js';
import { getContext } from '/scripts/extensions.js';
import { isBoundedChatSurfaceView, jumpBoundedChatSurfaceToMessage, resetChatSurfaceView } from '/script.js';
import { DEFAULT_CLICHE_TERMS } from './cliche-guard.js';
import { isContinuedNovelFloor } from './context-assembler.js';
import { loadCanonDb, loadLedger, loadNovelData, saveLedger } from './storage.js';

const PROGRESS_META_KEY = 'novel_continuation_progress';
const TOC_PAGE_LIMIT = 100;

let workbenchOpen = false;
let activeTab = 'memory';
let memoryFilter = 'all';
let showAllOriginalChapters = false;
let editingCharacterId = null;
let editingEventId = null;

let cachedNovelData = null;
let cachedLedger = null;
let cachedCanonDb = null;
let cachedAnchorInfo = null;
let handlers = {};

const outlineDraftUiState = {
    userBrief: '',
    sceneCount: 4,
    paceMode: 'slow',
    selectedHookIds: null, // null = auto-inherit pinned hooks
    initializedForScope: null,
};

const liveTaskState = {
    memory: { running: false, text: '', error: false, logs: [] },
    outline: { running: false, text: '', error: false },
    style: { running: false, text: '', error: false, logs: [] },
    cliche: { running: false, text: '', error: false },
};
let lastBridgeUi = { state: 'disconnected', detail: '未连接外部 Agent' };

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
 * Mounts the ultra-slim single-row mini bar above `#send_form` and the LittleWhiteBox-style Workbench modal.
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
            <i class="fa-solid fa-book-open"></i> <span>沉浸</span>
        </button>
        <button type="button" id="tt-novel-btn-prev-ch" class="tt-novel-pill tt-novel-pill-icon" title="观看上一章">
            <i class="fa-solid fa-chevron-left"></i>
        </button>
        <button type="button" id="tt-novel-btn-next-ch" class="tt-novel-pill tt-novel-pill-icon" title="观看下一章">
            <i class="fa-solid fa-chevron-right"></i>
        </button>
        <button type="button" id="tt-novel-btn-toc" class="tt-novel-pill" title="打开章节目录与夺舍截断">
            <i class="fa-solid fa-list-ul"></i> <span id="tt-novel-toc-badge">目录</span>
        </button>
        <button type="button" id="tt-novel-btn-workbench" class="tt-novel-pill tt-novel-pill-accent" title="打开小说续写工作台（剧情/人物/文风蒸馏/反八股/设置）">
            <i class="fa-solid fa-wand-magic-sparkles"></i> <span>工作台</span>
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
        const clicheInfo = handlers.getLatestClicheStatus?.();
        const targetTab = (clicheInfo?.report?.totalHits > 0 && activeTab === 'memory') ? 'memory' : activeTab;
        void openWorkbench(targetTab || 'memory');
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
        <div class="tt-novel-wb-modal" role="dialog" aria-modal="true" aria-label="小说续写工作台">
            <header class="tt-novel-wb-header">
                <div class="tt-novel-wb-title-wrap">
                    <div id="tt-novel-wb-title" class="tt-novel-wb-title">📖 小说续写工作台</div>
                    <div id="tt-novel-wb-subtitle" class="tt-novel-wb-subtitle"></div>
                </div>
                <button type="button" id="tt-novel-wb-close" class="tt-novel-icon-btn" title="关闭工作台">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </header>
            <nav class="tt-novel-wb-tabs" id="tt-novel-wb-tabs">
                <button type="button" class="tt-novel-wb-tab" data-tab="memory">📚 剧情与人物</button>
                <button type="button" class="tt-novel-wb-tab" data-tab="outline">🎬 导演大纲</button>
                <button type="button" class="tt-novel-wb-tab" data-tab="style">🎨 文风蒸馏</button>
                <button type="button" class="tt-novel-wb-tab" data-tab="cliche">🧹 反八股<span id="tt-novel-tab-cliche-dot" class="tt-novel-tab-dot displayNone"></span></button>
                <button type="button" class="tt-novel-wb-tab" data-tab="toc">📑 目录</button>
                <button type="button" class="tt-novel-wb-tab" data-tab="settings">⚙️ 设置</button>
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
            activeTab = btn.getAttribute('data-tab') || 'memory';
            renderWorkbench();
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && workbenchOpen) {
            closeWorkbench();
        }
    });
}

export async function openWorkbench(tabName) {
    if (tabName) activeTab = tabName;
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
    if (workbenchOpen && activeTab === tabName) {
        renderWorkbench();
    }
}

export function updateBridgeStatusUi({ state, detail }) {
    lastBridgeUi = { state: state || 'disconnected', detail: detail || state || '' };
    const statusEl = document.getElementById('tt-novel-bridge-status');
    if (statusEl) {
        const icon = state === 'connected' ? '🟢' : (state === 'connecting' ? '🟡' : (state === 'error' ? '🔴' : '⚪'));
        statusEl.textContent = `${icon} ${lastBridgeUi.detail}`;
    }
}

/**
 * Refreshes cached book/ledger/canon data, updates the mini bar badge, and re-renders Workbench if open.
 */
export async function refreshReaderWidgets() {
    const [novelData, ledger, canonDb, anchorInfo] = await Promise.all([
        loadNovelData(),
        loadLedger(),
        loadCanonDb(),
        handlers.getLatestChapterAnchorInfo?.() ?? null,
    ]);
    cachedNovelData = novelData;
    cachedLedger = ledger;
    cachedCanonDb = canonDb;
    cachedAnchorInfo = anchorInfo;

    const currentChatKey = String(getContext()?.chatId || novelData?.title || '');
    if (outlineDraftUiState.initializedForScope !== currentChatKey) {
        outlineDraftUiState.initializedForScope = currentChatKey;
        const saved = ledger?.draftOutline;
        outlineDraftUiState.userBrief = saved?.userBrief || '';
        outlineDraftUiState.sceneCount = Number(saved?.sceneCount || 4);
        outlineDraftUiState.paceMode = saved?.paceMode || 'slow';
        outlineDraftUiState.selectedHookIds = Array.isArray(saved?.selectedHookIds) ? [...saved.selectedHookIds] : null;
    }

    const badge = document.getElementById('tt-novel-toc-badge');
    if (badge) {
        badge.textContent = novelData?.totalChapters
            ? `目录 ${novelData.cutoffChapterIndex}/${novelData.totalChapters}`
            : '目录';
    }

    const wbBadge = document.getElementById('tt-novel-wb-badge');
    const clicheDot = document.getElementById('tt-novel-tab-cliche-dot');
    const clicheInfo = handlers.getLatestClicheStatus?.();
    const clicheHits = Number(clicheInfo?.report?.totalHits || 0);
    const openHooksCount = (ledger?.hooks || []).filter(h => h.status !== 'resolved').length;

    if (wbBadge) {
        if (clicheHits > 0) {
            wbBadge.textContent = `⚠${clicheHits}`;
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
    if (titleEl) {
        titleEl.textContent = cachedNovelData?.title
            ? `📖 《${cachedNovelData.title}》`
            : '📖 小说续写工作台';
    }
    if (subEl) {
        const chPart = cachedNovelData?.totalChapters
            ? `锚点 #${cachedNovelData.cutoffChapterIndex}/${cachedNovelData.totalChapters} · `
            : '';
        subEl.textContent = `${chPart}模型：${meta.activeModel || '当前酒馆模型'} · 预设：${meta.presetLabel || '当前酒馆预设'}`;
    }

    document.querySelectorAll('#tt-novel-wb-tabs .tt-novel-wb-tab').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === activeTab);
    });

    if (activeTab === 'memory') renderMemoryTab(bodyEl);
    else if (activeTab === 'outline') renderOutlineTab(bodyEl);
    else if (activeTab === 'style') renderStyleTab(bodyEl);
    else if (activeTab === 'cliche') renderClicheTab(bodyEl);
    else if (activeTab === 'toc') renderTocTab(bodyEl);
    else if (activeTab === 'settings') renderSettingsTab(bodyEl);
}

/* ==========================================================================
   TAB 1.5: 🎬 导演大纲 (Author-Authentic Multi-Cut Chapter Beat Director)
   ========================================================================== */
function renderOutlineTab(bodyEl) {
    const ledger = cachedLedger || { chronicle: [], characters: [], hooks: [], styleProfile: null, draftOutline: null };
    const openHooks = (ledger.hooks || []).filter(h => h && h.status !== 'resolved');
    const task = liveTaskState.outline;
    const savedDraft = ledger.draftOutline || null;

    if (outlineDraftUiState.selectedHookIds === null) {
        outlineDraftUiState.selectedHookIds = openHooks.filter(h => h.status === 'pinned').map(h => h.id);
    }
    const selectedHookSet = new Set(outlineDraftUiState.selectedHookIds);

    const anchorText = cachedAnchorInfo?.anchorTitle
        ? `自动承接【${cachedAnchorInfo.anchorTitle}】结尾${cachedAnchorInfo.shortClosing ? `（“……${cachedAnchorInfo.shortClosing.slice(-36)}”）` : ''} → 策划第 ${cachedAnchorInfo.nextChapterIndex} ${cachedAnchorInfo.chapterUnit}`
        : '请先导入原著小说';

    const readyMeta = `已自动挂载：${ledger.characters?.length || 0} 人物防 OOC 档案 · ${ledger.chronicle?.length || 0} 条编年史 · ${openHooks.length} 条待填伏笔 · ${ledger.styleProfile?.styleCard ? `文风圣经(${String(ledger.styleProfile.styleCard).length}字)` : '未蒸馏文风'}`;

    const progressHtml = task.text
        ? `<div class="tt-novel-banner ${task.error ? 'is-error' : (task.running ? 'is-running' : 'is-ok')}">${escapeHtml(task.text)}</div>`
        : '';

    const hookPickerHtml = openHooks.length === 0
        ? '<div class="tt-novel-muted">当前暂无待填伏笔（可去「📚 剧情与人物」全本归档或手动添加伏笔）。</div>'
        : `
            <div class="tt-novel-hook-picker">
                ${openHooks.map(h => {
                    const active = selectedHookSet.has(h.id);
                    const shortLabel = h.content.length > 34 ? `${h.content.slice(0, 34)}…` : h.content;
                    return `
                        <button type="button" class="tt-novel-filter-pill ${active ? 'active' : ''}" data-action="toggle-outline-hook" data-id="${escapeHtml(h.id)}" title="${escapeHtml(h.content)}">
                            ${active ? '🎯' : '🔮'} #${Number(h.plantedChapter || 1)} ${escapeHtml(shortLabel)}
                        </button>
                    `;
                }).join('')}
            </div>
        `;

    bodyEl.innerHTML = `
        <div class="tt-novel-banner">
            <div><b>📍 ${escapeHtml(anchorText)}</b></div>
            <div class="tt-novel-muted">${escapeHtml(readyMeta)}</div>
        </div>

        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">📝 输入你的简略过程与结果（只需 1~3 句大白话，AI 帮你扩成原著风多切镜导演大纲）</div>
            <textarea id="tt-novel-outline-brief" class="text_pole" rows="3" placeholder="例如：次日清晨设备改造收尾，博士来探口风试探昨晚吃饭的事但没挑破照片，贪鼬顺手碰一下帘子后门的伏笔并再次试探凯尔希，结尾定下明天出海。&#10;（也可以留空，点下方「🎲 留空自动构思下一章」让 AI 顺着当前伏笔直接给方案！）">${escapeHtml(outlineDraftUiState.userBrief || '')}</textarea>
            <div class="tt-novel-row-2">
                <label class="tt-novel-muted">切镜数量：
                    <select id="tt-novel-outline-scenes" class="text_pole">
                        <option value="3" ${Number(outlineDraftUiState.sceneCount) === 3 ? 'selected' : ''}>3 镜头（紧凑）</option>
                        <option value="4" ${Number(outlineDraftUiState.sceneCount || 4) === 4 ? 'selected' : ''}>4 镜头（原著标准·推荐）</option>
                        <option value="5" ${Number(outlineDraftUiState.sceneCount) === 5 ? 'selected' : ''}>5 镜头（多线冷热交替）</option>
                    </select>
                </label>
                <label class="tt-novel-muted">剧情推进步幅：
                    <select id="tt-novel-outline-pace" class="text_pole">
                        <option value="slow" ${outlineDraftUiState.paceMode === 'slow' ? 'selected' : ''}>温水煮青蛙（稳步铺垫·不急摊牌）</option>
                        <option value="medium" ${outlineDraftUiState.paceMode === 'medium' ? 'selected' : ''}>中速推进（小冲突/试探升级）</option>
                        <option value="climax" ${outlineDraftUiState.paceMode === 'climax' ? 'selected' : ''}>高潮爆点（重点回收伏笔）</option>
                    </select>
                </label>
            </div>
            <details class="tt-novel-fold-card" ${openHooks.length <= 8 ? 'open' : ''}>
                <summary>🎯 勾选本章想顺手沾边或推进的伏笔（已选 ${selectedHookSet.size} / ${openHooks.length}，建议每次只选 1~2 条）</summary>
                <div style="margin-top: 6px;">${hookPickerHtml}</div>
            </details>
            <div class="tt-novel-action-bar">
                <button type="button" id="tt-novel-outline-generate" class="menu_button tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                    🎬 生成原味导演大纲 (1次API · 套预设)
                </button>
                <button type="button" id="tt-novel-outline-auto" class="menu_button" ${task.running ? 'disabled' : ''}>
                    🎲 留空自动构思下一章
                </button>
            </div>
        </section>

        ${progressHtml}

        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">📋 生成结果（可直接手动微调，确认后一键送入聊天框续写）</div>
            <textarea id="tt-novel-outline-output" class="text_pole tt-novel-style-editor" rows="10" placeholder="点击上方「🎬 生成原味导演大纲」后，严格贴合原著节奏、零网文八股的分镜导演大纲会显示在这里...">${escapeHtml(savedDraft?.outlineText || '')}</textarea>
            <div class="tt-novel-action-bar">
                <button type="button" id="tt-novel-outline-fill" class="menu_button" ${!savedDraft?.outlineText ? '' : ''}>
                    📋 一键填入聊天输入框
                </button>
                <button type="button" id="tt-novel-outline-send" class="menu_button tt-novel-btn-primary">
                    🚀 填入并直接续写本章
                </button>
                <button type="button" id="tt-novel-outline-save" class="menu_button tt-novel-btn-sm">
                    💾 暂存修改
                </button>
            </div>
        </section>
    `;

    const briefEl = bodyEl.querySelector('#tt-novel-outline-brief');
    const scenesEl = bodyEl.querySelector('#tt-novel-outline-scenes');
    const paceEl = bodyEl.querySelector('#tt-novel-outline-pace');
    const outputEl = bodyEl.querySelector('#tt-novel-outline-output');

    briefEl?.addEventListener('input', (e) => {
        outlineDraftUiState.userBrief = String(e.target.value || '');
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
            paceMode: outlineDraftUiState.paceMode,
        });
    });

    bodyEl.querySelector('#tt-novel-outline-auto')?.addEventListener('click', () => {
        handlers.onGenerateDirectorOutline?.({
            userBrief: '',
            selectedHookIds: outlineDraftUiState.selectedHookIds || [],
            sceneCount: outlineDraftUiState.sceneCount,
            paceMode: outlineDraftUiState.paceMode,
        });
    });

    const saveCurrentDraft = async () => {
        const cur = await loadLedger();
        cur.draftOutline = {
            ...(cur.draftOutline || {}),
            userBrief: String(briefEl?.value || '').trim(),
            outlineText: String(outputEl?.value || '').trim(),
            sceneCount: outlineDraftUiState.sceneCount,
            paceMode: outlineDraftUiState.paceMode,
            selectedHookIds: [...(outlineDraftUiState.selectedHookIds || [])],
            updatedAt: Date.now(),
        };
        await saveLedger(cur);
        cachedLedger = cur;
    };

    bodyEl.querySelector('#tt-novel-outline-save')?.addEventListener('click', async () => {
        await saveCurrentDraft();
        globalThis.toastr?.success?.('已暂存当前导演大纲草稿！', '小说续写阅读器');
    });

    bodyEl.querySelector('#tt-novel-outline-fill')?.addEventListener('click', async () => {
        await saveCurrentDraft();
        handlers.onApplyOutlineToChat?.(String(outputEl?.value || '').trim(), { autoSend: false });
    });

    bodyEl.querySelector('#tt-novel-outline-send')?.addEventListener('click', async () => {
        await saveCurrentDraft();
        handlers.onApplyOutlineToChat?.(String(outputEl?.value || '').trim(), { autoSend: true });
    });
}

/* ==========================================================================
   TAB 1: 📚 剧情与人物 (LittleWhiteBox-Style Structured Memory Dashboard)
   ========================================================================== */
function renderMemoryTab(bodyEl) {
    const ledger = cachedLedger || { chronicle: [], characters: [], hooks: [], worldStates: [], summaries: [], archiveBatches: [] };
    const chars = ledger.characters || [];
    const chronicle = ledger.chronicle || [];
    const hooks = ledger.hooks || [];
    const worldStates = ledger.worldStates || [];
    const summaries = ledger.summaries || [];
    const batches = ledger.archiveBatches || [];
    const failedBatches = batches.filter(b => b.status !== 'ok');
    const okBatchCount = batches.length - failedBatches.length;
    const openHooks = hooks.filter(h => h.status !== 'resolved');
    const resolvedHooks = hooks.filter(h => h.status === 'resolved');
    const task = liveTaskState.memory;
    const processLogs = task.running && task.logs.length > 0 ? task.logs : (ledger.archiveProcessLog || []);

    const progressHtml = task.text
        ? `<div class="tt-novel-banner ${task.error ? 'is-error' : (task.running ? 'is-running' : 'is-ok')}">${escapeHtml(task.text)}</div>`
        : '';

    const failedRangeText = failedBatches.map(b => `第${b.startChapter}~${b.endChapter}章`).join('、');
    const sliceManagerHtml = batches.length > 0
        ? `
        <details class="tt-novel-fold-card tt-novel-slice-box" ${(failedBatches.length > 0 || ledger.archiveNeedsResynth) ? 'open' : ''}>
            <summary>
                🧩 分批切片管理（共 ${batches.length} 片 · ✅ ${okBatchCount} 正常${failedBatches.length > 0 ? ` · ⚠️ ${failedBatches.length} 道歉/失败` : ''}）
            </summary>
            <div class="tt-novel-slice-body">
                ${failedBatches.length > 0 ? `<div class="tt-novel-banner is-warn">⚠️ 以下切片疑似模型道歉或失败，尚未纳入总账：<b>${escapeHtml(failedRangeText)}</b>。可直接在下方点「🔄 重跑此切片」，或去「⚙️ 设置」换自定义 API / 调整预设后再重跑！</div>` : ''}
                ${ledger.archiveNeedsResynth ? '<div class="tt-novel-banner is-running">💡 已有切片完成重跑更新，请点击下方「🔁 用当前切片重新合稿总账」将新内容合并进编年史与人物卡。</div>' : ''}
                <div class="tt-novel-action-bar">
                    ${failedBatches.length > 0 ? `<button type="button" id="tt-novel-rerun-failed-slices" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>⚡ 一键重跑全部失败切片 (${failedBatches.length})</button>` : ''}
                    <button type="button" id="tt-novel-resynth-slices" class="menu_button tt-novel-btn-sm ${(ledger.archiveNeedsResynth || chars.length === 0) ? 'tt-novel-btn-primary' : ''}" ${task.running || okBatchCount === 0 ? 'disabled' : ''}>
                        🔁 用当前正常切片重新合稿总账（不重读原文）
                    </button>
                </div>
                <div class="tt-novel-slice-list">
                    ${batches.map(b => {
                        const isOk = b.status === 'ok';
                        const isRefused = b.status === 'refused';
                        const chipClass = isOk ? 'is-ok' : 'is-danger';
                        const statusText = isOk ? '✅ 正常' : (isRefused ? '⚠️ 疑似道歉' : '❌ 异常');
                        return `
                            <div class="tt-novel-slice-row ${isOk ? '' : 'is-bad'}">
                                <div class="tt-novel-slice-head">
                                    <div class="tt-novel-slice-info">
                                        <span class="tt-novel-chip ${chipClass}">${statusText}</span>
                                        <strong>切片 #${b.batchIndex} · 第 ${b.startChapter}~${b.endChapter} 章</strong>
                                        <span class="tt-novel-muted">${b.charCount ? `${b.charCount}字` : ''}</span>
                                    </div>
                                    <button type="button" class="menu_button tt-novel-btn-sm" data-action="rerun-slice" data-batch="${b.batchIndex}" ${task.running ? 'disabled' : ''}>
                                        🔄 重跑此切片
                                    </button>
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
        <details class="tt-novel-fold-card" ${task.running ? 'open' : ''}>
            <summary>🔬 查看合稿与运行日志（${processLogs.length} 条记录）</summary>
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

    const charCardsHtml = chars.length === 0
        ? '<div class="tt-novel-empty">尚未生成核心人物档案。点击上方「📚 全本通读归档」自动按原著提取 4 维灵魂与防 OOC 红线（全程套用所选预设，不拒答）。</div>'
        : chars.map(ch => {
            if (editingCharacterId === ch.id) {
                return `
                    <div class="tt-novel-card tt-novel-char-card is-editing" data-char-id="${escapeHtml(ch.id)}">
                        <div class="tt-novel-edit-grid">
                            <input type="text" class="text_pole" data-field="name" value="${escapeHtml(ch.name)}" placeholder="人物姓名" />
                            <input type="text" class="text_pole" data-field="role" value="${escapeHtml(ch.role || '')}" placeholder="身份定位" />
                            <label>🎮 原作/游戏设定底骨与能力：<textarea class="text_pole" rows="2" data-field="canonFoundation">${escapeHtml(ch.canonFoundation || '')}</textarea></label>
                            <label>🎭 同人当前处境与关系：<textarea class="text_pole" rows="2" data-field="currentSituation">${escapeHtml(ch.currentSituation || '')}</textarea></label>
                            <label>🗣️ 原著真实言行与原话锚点：<textarea class="text_pole" rows="2" data-field="voiceAndQuotes">${escapeHtml(ch.voiceAndQuotes || '')}</textarea></label>
                            <label>🚫 绝对 OOC 红线：<textarea class="text_pole" rows="2" data-field="oocRedLines">${escapeHtml(ch.oocRedLines || '')}</textarea></label>
                        </div>
                        <div class="tt-novel-card-actions">
                            <button type="button" class="menu_button tt-novel-btn-sm" data-action="save-char" data-id="${escapeHtml(ch.id)}">💾 保存</button>
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
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-char" data-id="${escapeHtml(ch.id)}" title="编辑人物档案">✏️</button>
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="del-char" data-id="${escapeHtml(ch.id)}" title="删除">🗑️</button>
                        </div>
                    </div>
                    ${ch.canonFoundation ? `<div class="tt-novel-char-row is-canon"><span>🎮 原作底骨</span><p>${escapeHtml(ch.canonFoundation)}</p></div>` : ''}
                    ${ch.currentSituation ? `<div class="tt-novel-char-row is-sit"><span>🎭 当前处境</span><p>${escapeHtml(ch.currentSituation)}</p></div>` : ''}
                    ${ch.voiceAndQuotes ? `<div class="tt-novel-char-row is-voice"><span>🗣️ 言行原话</span><p>${escapeHtml(ch.voiceAndQuotes)}</p></div>` : ''}
                    ${ch.oocRedLines ? `<div class="tt-novel-char-row is-ooc"><span>🚫 OOC红线</span><p>${escapeHtml(ch.oocRedLines)}</p></div>` : ''}
                </div>
            `;
        }).join('');

    const chronicleHtml = chronicle.length === 0
        ? '<div class="tt-novel-empty">暂无全本剧情编年史。点击「📚 全本通读归档」后，会按时间顺序生成客观、无 RPG 标签污染的剧情时间轴。</div>'
        : chronicle.map(evt => {
            if (editingEventId === evt.id) {
                return `
                    <div class="tt-novel-card is-editing" data-evt-id="${escapeHtml(evt.id)}">
                        <div class="tt-novel-edit-grid">
                            <div class="tt-novel-row-2">
                                <input type="text" class="text_pole" data-field="chapterRange" value="${escapeHtml(evt.chapterRange || '')}" placeholder="章号如 #1-#7" />
                                <input type="text" class="text_pole" data-field="timeLabel" value="${escapeHtml(evt.timeLabel || '')}" placeholder="时间阶段" />
                            </div>
                            <input type="text" class="text_pole" data-field="title" value="${escapeHtml(evt.title || '')}" placeholder="事件标题" />
                            <input type="text" class="text_pole" data-field="participants" value="${escapeHtml((evt.participants || []).join('、'))}" placeholder="出场人物（顿号分隔）" />
                            <textarea class="text_pole" rows="3" data-field="summary" placeholder="客观剧情经过与结果">${escapeHtml(evt.summary || '')}</textarea>
                            <input type="text" class="text_pole" data-field="infoGap" value="${escapeHtml(evt.infoGap || '')}" placeholder="信息差（谁还不知道什么）" />
                        </div>
                        <div class="tt-novel-card-actions">
                            <button type="button" class="menu_button tt-novel-btn-sm" data-action="save-evt" data-id="${escapeHtml(evt.id)}">💾 保存</button>
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
                            <strong>${escapeHtml(evt.title)}</strong>
                            ${evt.timeLabel ? `<span class="tt-novel-muted">${escapeHtml(evt.timeLabel)}</span>` : ''}
                        </div>
                        <div class="tt-novel-card-actions">
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-evt" data-id="${escapeHtml(evt.id)}">✏️</button>
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="del-evt" data-id="${escapeHtml(evt.id)}">🗑️</button>
                        </div>
                    </div>
                    ${(evt.participants || []).length > 0 ? `<div class="tt-novel-chip-row">${evt.participants.map(p => `<span class="tt-novel-chip">${escapeHtml(p)}</span>`).join('')}</div>` : ''}
                    <div class="tt-novel-card-text">${escapeHtml(evt.summary)}</div>
                    ${evt.infoGap ? `<div class="tt-novel-infogap">🔍 信息差：${escapeHtml(evt.infoGap)}</div>` : ''}
                </div>
            `;
        }).join('');

    const renderHookItem = (h) => `
        <div class="tt-novel-hook-row ${h.status === 'pinned' ? 'is-pinned' : ''} ${h.status === 'resolved' ? 'is-resolved' : ''}">
            <div class="tt-novel-hook-text">
                <span class="tt-novel-chip">#${Number(h.plantedChapter || 1)}</span>
                <span>${escapeHtml(h.content)}</span>
                ${h.resolvedChapter ? `<span class="tt-novel-muted">（已于第${h.resolvedChapter}章回收）</span>` : ''}
            </div>
            <div class="tt-novel-card-actions">
                ${h.status !== 'resolved' ? `<button type="button" class="tt-novel-mini-icon-btn" data-action="pin-hook" data-id="${escapeHtml(h.id)}" title="切换是否本章重点推进">${h.status === 'pinned' ? '🎯' : '📌'}</button>` : ''}
                <button type="button" class="tt-novel-mini-icon-btn" data-action="resolve-hook" data-id="${escapeHtml(h.id)}" title="${h.status === 'resolved' ? '重新打开伏笔' : '标记已填坑'}">${h.status === 'resolved' ? '↩️' : '✅'}</button>
                <button type="button" class="tt-novel-mini-icon-btn" data-action="del-hook" data-id="${escapeHtml(h.id)}" title="删除伏笔">🗑️</button>
            </div>
        </div>
    `;

    const hooksHtml = hooks.length === 0
        ? '<div class="tt-novel-empty">暂无伏笔记录。续写时会自动通过末段指令提取新伏笔与已填坑，也可以点击上方「+ 伏笔」手动埋线。</div>'
        : `
            ${openHooks.map(renderHookItem).join('')}
            ${resolvedHooks.length > 0 ? `<details class="tt-novel-fold-card"><summary>已回收伏笔（${resolvedHooks.length}）</summary>${resolvedHooks.map(renderHookItem).join('')}</details>` : ''}
        `;

    const worldAndSumsHtml = (worldStates.length === 0 && summaries.length === 0)
        ? '<div class="tt-novel-empty">暂无势力/物品状态或单章续写摘要。</div>'
        : `
            ${worldStates.length > 0 ? `<div class="tt-novel-chip-list">${worldStates.map(w => `<div class="tt-novel-state-row"><span class="tt-novel-chip">[${escapeHtml(w.category || '状态')}] ${escapeHtml(w.name)}</span><span>${escapeHtml(w.state)}</span></div>`).join('')}</div>` : ''}
            ${summaries.length > 0 ? `<div class="tt-novel-subhead">📝 近期续写单章摘要（${summaries.length}）</div>${summaries.slice(-10).map(s => `<div class="tt-novel-state-row"><span class="tt-novel-chip is-gold">第${s.chapterIndex}章</span><span>${escapeHtml(s.summary)}</span></div>`).join('')}` : ''}
        `;

    const showChars = memoryFilter === 'all' || memoryFilter === 'chars';
    const showChronicle = memoryFilter === 'all' || memoryFilter === 'chronicle';
    const showHooks = memoryFilter === 'all' || memoryFilter === 'hooks';
    const showWorld = memoryFilter === 'all' || memoryFilter === 'world';

    bodyEl.innerHTML = `
        <div class="tt-novel-action-bar">
            <button type="button" id="tt-novel-run-archive-full" class="menu_button tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                📚 全本通读归档 (并发≤2 · 套预设)
            </button>
            <button type="button" id="tt-novel-run-archive-inc" class="menu_button" ${task.running ? 'disabled' : ''}>
                ⚡ 增量补总结新章
            </button>
            <button type="button" id="tt-novel-add-char" class="menu_button">+ 人物</button>
            <button type="button" id="tt-novel-add-hook" class="menu_button">+ 伏笔</button>
        </div>
        <div class="tt-novel-subfilter">
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'all' ? 'active' : ''}" data-filter="all">全部总览</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'chars' ? 'active' : ''}" data-filter="chars">👤 人物 (${chars.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'chronicle' ? 'active' : ''}" data-filter="chronicle">📜 编年史 (${chronicle.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'hooks' ? 'active' : ''}" data-filter="hooks">🎯 伏笔 (${openHooks.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'world' ? 'active' : ''}" data-filter="world">🌍 状态 (${worldStates.length + summaries.length})</button>
        </div>
        ${progressHtml}
        ${sliceManagerHtml}
        ${logHtml}
        ${showChars ? `<section class="tt-novel-section"><div class="tt-novel-section-title">👤 核心人物 4 维灵魂与防 OOC 档案（已归档至第 ${ledger.lastArchivedChapter || 0} 章）</div><div class="tt-novel-card-grid">${charCardsHtml}</div></section>` : ''}
        ${showChronicle ? `<section class="tt-novel-section"><div class="tt-novel-section-title">📜 全本剧情编年史（无 RP 标签 · 保留信息差）</div><div class="tt-novel-card-stack">${chronicleHtml}</div></section>` : ''}
        ${showHooks ? `<section class="tt-novel-section"><div class="tt-novel-section-title">🎯 伏笔与暗线追踪（点 🎯 设为本章重点推进）</div><div class="tt-novel-card-stack">${hooksHtml}</div></section>` : ''}
        ${showWorld ? `<section class="tt-novel-section"><div class="tt-novel-section-title">🌍 势力 / 物品 / 单章状态记录</div><div class="tt-novel-card-stack">${worldAndSumsHtml}</div></section>` : ''}
    `;

    bodyEl.querySelector('#tt-novel-run-archive-full')?.addEventListener('click', () => handlers.onRunArchive?.('full'));
    bodyEl.querySelector('#tt-novel-run-archive-inc')?.addEventListener('click', () => handlers.onRunArchive?.('incremental'));
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
            memoryFilter = btn.getAttribute('data-filter') || 'all';
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
            currentSituation: '',
            voiceAndQuotes: '',
            oocRedLines: '',
            updatedChapter: Number(cachedNovelData?.cutoffChapterIndex || 1),
        };
        cur.characters.push(newChar);
        await saveLedger(cur);
        editingCharacterId = newChar.id;
        await refreshReaderWidgets();
    });

    bodyEl.querySelector('#tt-novel-add-hook')?.addEventListener('click', async () => {
        const text = window.prompt('请输入要埋下或本章要推进的伏笔线索：');
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
                target.chapterRange = val('chapterRange') || target.chapterRange;
                target.timeLabel = val('timeLabel');
                target.title = val('title') || target.title;
                target.participants = val('participants').split(/[、,，\s]+/).filter(Boolean);
                target.summary = val('summary') || target.summary;
                target.infoGap = val('infoGap');
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

    // Hook bindings
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
}

/* ==========================================================================
   TAB 2: 🎨 文风蒸馏工坊 (Full Transparent Process Viewer)
   ========================================================================== */
function renderStyleTab(bodyEl) {
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
        ? '<div class="tt-novel-empty">尚未执行文风蒸馏。点击上方按钮开始后，这里会实时展示【阶段 0 本地指纹 → 1A/1B 深度解剖 → 2A 初版圣经 → 每轮盲测大纲/仿写稿/原著真迹对比/5 维评分与揪出的破绽】全过程。</div>'
        : logs.map(item => {
            if (item.type === 'round') {
                return `
                    <details class="tt-novel-round-card" open>
                        <summary class="tt-novel-round-head">
                            <span><strong>${escapeHtml(item.title || `第 ${item.round} 轮盲测`)}</strong></span>
                            <span class="tt-novel-score-pill ${scoreBadgeClass(item.score)}">
                                ${item.score !== null && item.score !== undefined ? `${item.score} / 100 分` : '已评估'}
                            </span>
                        </summary>
                        <div class="tt-novel-round-body">
                            ${item.driftReport ? `
                                <div class="tt-novel-diff-box" style="border-left-color: #4ac4b7;">
                                    <div class="tt-novel-mini-label">📊 本地 0-API 客观物理指标比对（真迹 vs 盲写）</div>
                                    <div class="tt-novel-pre-wrap">${escapeHtml(item.driftReport)}</div>
                                </div>
                            ` : ''}
                            <div class="tt-novel-diff-box">
                                <div class="tt-novel-mini-label">⚖️ 5 维纯文风评分与本轮揪出的破绽（圣经更新至 ${item.styleCardLength || '?'} 字）</div>
                                <div class="tt-novel-pre-wrap">${escapeHtml(item.diffNotes || '')}</div>
                            </div>
                            <details class="tt-novel-subfold">
                                <summary>📋 盲测考题（剥离文风后的干瘪节拍大纲）</summary>
                                <div class="tt-novel-pre-wrap">${escapeHtml(item.dryOutline || '')}</div>
                            </details>
                            <details class="tt-novel-subfold">
                                <summary>🔍 原著真迹 vs AI 盲测仿写稿（展开左右对照）</summary>
                                <div class="tt-novel-compare-grid">
                                    <div class="tt-novel-compare-col">
                                        <div class="tt-novel-mini-label">📜 原作者真迹（${escapeHtml(item.holdoutLabel || '')}）</div>
                                        <div class="tt-novel-compare-text">${escapeHtml(item.holdoutTruth || '')}</div>
                                    </div>
                                    <div class="tt-novel-compare-col">
                                        <div class="tt-novel-mini-label">🤖 AI 本轮蒙眼仿写稿</div>
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

    const progressHtml = task.text
        ? `<div class="tt-novel-banner ${task.error ? 'is-error' : (task.running ? 'is-running' : 'is-ok')}">${escapeHtml(task.text)}</div>`
        : '';

    const cardLen = sp?.styleCard ? String(sp.styleCard).length : 0;
    const isBloatedCard = cardLen > 3500;
    const bloatedWarnHtml = isBloatedCard
        ? `<div class="tt-novel-banner is-warn">⚠️ 当前文风圣经长达 <b>${cardLen} 字</b>（超出理想实战体量 1,800~2,600 字），容易引发跨章节过拟合复读与 Token 浪费。建议直接点下方「✨ 一键去过拟合提纯瘦身」保留全部洞察并压缩至 ~2,200 字！</div>`
        : '';

    bodyEl.innerHTML = `
        <div class="tt-novel-action-bar">
            <select id="tt-novel-wb-distill-rounds" class="text_pole" style="width: 108px;">
                <option value="1" ${Number(settings.distillRounds) === 1 ? 'selected' : ''}>1 轮盲测</option>
                <option value="2" ${Number(settings.distillRounds || 2) === 2 ? 'selected' : ''}>2 轮 (推荐)</option>
                <option value="3" ${Number(settings.distillRounds) === 3 ? 'selected' : ''}>3 轮 (深度)</option>
            </select>
            <button type="button" id="tt-novel-wb-distill-start" class="menu_button tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                🎨 开始全流程对抗蒸馏 (并发≤2 · 套预设)
            </button>
            <button type="button" id="tt-novel-wb-distill-refine" class="menu_button" ${task.running || !sp?.styleCard ? 'disabled' : ''}>
                🔄 追加 1 轮盲测精炼
            </button>
            <button type="button" id="tt-novel-wb-compress-style" class="menu_button ${isBloatedCard ? 'tt-novel-btn-primary' : ''}" ${task.running || !sp?.styleCard ? 'disabled' : ''}>
                ✨ 一键去过拟合提纯瘦身 (1次API)
            </button>
            <button type="button" id="tt-novel-wb-eval-style" class="menu_button" ${task.running || !sp?.styleCard ? 'disabled' : ''}>
                🧪 纯跑分盲测验收 (不改圣经)
            </button>
        </div>
        ${bloatedWarnHtml}
        ${progressHtml}
        <section class="tt-novel-section">
            <div class="tt-novel-section-title">🔬 蒸馏全过程透明视图（每一步产出与真迹/仿写对照均可展开核验）</div>
            <div class="tt-novel-card-stack">${processTimelineHtml}</div>
        </section>
        <section class="tt-novel-section">
            <div class="tt-novel-section-title">🧬 终版《原著文风骨相 DNA 圣经》（${sp?.styleCard ? `${String(sp.styleCard).length} 字` : '未生成'} · 支持直接手动微调）</div>
            <textarea id="tt-novel-wb-style-editor" class="text_pole tt-novel-style-editor" rows="9" placeholder="蒸馏完成后的《原著文风骨相 DNA 圣经》会显示在这里...">${escapeHtml(sp?.styleCard || '')}</textarea>
            <details class="tt-novel-fold-card">
                <summary>📜 查看 / 编辑原著灵魂原文范例（Few-Shot 活样本）</summary>
                <textarea id="tt-novel-wb-excerpts-editor" class="text_pole tt-novel-style-editor" rows="6" placeholder="原著灵魂范例片段...">${escapeHtml(sp?.goldenExcerpts || '')}</textarea>
            </details>
            <div class="tt-novel-action-bar">
                <button type="button" id="tt-novel-wb-save-style" class="menu_button">💾 保存文风与范例修改</button>
                <button type="button" id="tt-novel-wb-clear-style" class="menu_button">🗑️ 清空文风卡</button>
            </div>
        </section>
    `;

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
        globalThis.toastr?.success?.(cardText ? '已保存修改后的文风骨相圣经！' : '已清空文风卡', '小说续写阅读器');
    });
    bodyEl.querySelector('#tt-novel-wb-clear-style')?.addEventListener('click', async () => {
        const cur = await loadLedger();
        cur.styleProfile = null;
        await saveLedger(cur);
        await refreshReaderWidgets();
        globalThis.toastr?.info?.('已清空当前对话的原著文风 DNA 卡', '小说续写阅读器');
    });
}

/* ==========================================================================
   TAB 3: 🧹 反八股体检 (Zero-API Cliché Scanner + Surgical De-Cliché)
   ========================================================================== */
function renderClicheTab(bodyEl) {
    const settings = handlers.getSettings?.() || {};
    const status = handlers.getLatestClicheStatus?.() || { hasContinuedFloor: false, report: null };
    const task = liveTaskState.cliche;
    const report = status.report;

    const progressHtml = task.text
        ? `<div class="tt-novel-banner ${task.error ? 'is-error' : (task.running ? 'is-running' : 'is-ok')}">${escapeHtml(task.text)}</div>`
        : '';

    let summaryHtml = '<div class="tt-novel-empty">当前尚未生成 AI 续写章节。续写完成后，插件会在本地 0 API 自动扫描高频八股词。</div>';
    if (status.hasContinuedFloor && report) {
        if (report.totalHits === 0) {
            summaryHtml = `<div class="tt-novel-banner is-ok">✅ 最新续写章节（第 ${status.chapterIndex} 章 / 楼层 #${status.floorIndex}）体检通过：未检出任何高频网文八股！</div>`;
        } else {
            summaryHtml = `
                <div class="tt-novel-banner is-warn">
                    ⚠️ 最新续写章节（第 ${status.chapterIndex} 章 / 楼层 #${status.floorIndex}）检出 <b>${report.totalHits}</b> 处高频八股（涉及：${escapeHtml(report.uniqueTerms.join('、'))}）
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
        <div class="tt-novel-action-bar">
            <button type="button" id="tt-novel-cliche-rescan" class="menu_button">🔍 重新扫描最新章 (0 API)</button>
            <button type="button" id="tt-novel-cliche-fix" class="menu_button tt-novel-btn-primary" ${task.running || !status.hasContinuedFloor ? 'disabled' : ''}>
                🧹 一键局部去八股精修 (1次API · 套预设 · 不改剧情)
            </button>
        </div>
        ${progressHtml}
        <section class="tt-novel-section">
            <div class="tt-novel-section-title">📋 最新续写章节八股体检报告</div>
            ${summaryHtml}
        </section>
        <section class="tt-novel-section">
            <div class="tt-novel-section-title">🚫 自定义补充严禁八股词表（每行或逗号分隔，续写与体检同步生效）</div>
            <textarea id="tt-novel-cliche-custom" class="text_pole" rows="3" placeholder="例如：瞳孔地震、如遭雷击、勾唇冷笑...">${escapeHtml(settings.clicheBlacklist || '')}</textarea>
            <details class="tt-novel-fold-card">
                <summary>查看内置高危八股监控词表（共 ${DEFAULT_CLICHE_TERMS.length} 项）</summary>
                <div class="tt-novel-chip-row">${DEFAULT_CLICHE_TERMS.map(t => `<span class="tt-novel-chip">${escapeHtml(t)}</span>`).join('')}</div>
            </details>
        </section>
    `;

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
   TAB 4: 📑 章节目录 (Unified TOC & Cutoff Manager)
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
        const firstLine = String(msg.mes || '').split('\n').map(l => l.trim()).find(Boolean) || '续写章节';
        const cleanHeading = firstLine.replace(/^#+\s*/, '').slice(0, 38);
        aiFloors.push({
            floorIdx,
            title: cleanHeading,
            swipeCount: Array.isArray(msg.swipes) ? msg.swipes.length : 1,
            wordCount: String(msg.mes || '').replace(/\s+/g, '').length,
        });
    });

    bodyEl.innerHTML = `
        <div class="tt-novel-toc-jumps">
            <button type="button" id="tt-novel-jump-cutoff" class="tt-novel-jump-btn">📍 跳至断更处</button>
            <button type="button" id="tt-novel-jump-latest" class="tt-novel-jump-btn">🔥 跳至最新章</button>
            <button type="button" id="tt-novel-jump-saved" class="tt-novel-jump-btn">🔖 上次阅读</button>
        </div>
        <input type="search" id="tt-novel-toc-search" class="text_pole" placeholder="搜索章节标题或原著关键词..." />
        <div id="tt-novel-toc-list" class="tt-novel-toc-list-inline"></div>
    `;

    const paintList = (filterText = '') => {
        const listEl = bodyEl.querySelector('#tt-novel-toc-list');
        if (!listEl) return;
        const q = filterText.trim().toLowerCase();
        const rows = [];

        if (novel?.chapters?.length) {
            const cutoff = novel.cutoffChapterIndex || novel.totalChapters;
            rows.push(`<div class="tt-novel-toc-divider">📚 原著章节（共 ${novel.totalChapters} 章 · 当前锚点 #${cutoff}）</div>`);
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
                const mountedFloor = originalFloorByChapter.get(ch.index);
                const isCutoff = ch.index === cutoff;
                const isAfter = ch.index > cutoff;
                const tagClass = isAfter ? 'masked' : (isCutoff ? 'cutoff' : 'orig');
                const tagText = isAfter ? '屏蔽' : (isCutoff ? '夺舍点' : '原著');
                rows.push(`
                    <div class="tt-novel-toc-item ${isCutoff ? 'is-cutoff' : ''} ${isAfter ? 'is-masked' : ''}">
                        <div class="tt-novel-toc-item-main" data-action="view-orig" data-orig-index="${ch.index}">
                            <span class="tt-novel-toc-tag ${tagClass}">${tagText}</span>
                            <span class="tt-novel-toc-name">${escapeHtml(ch.title)}</span>
                            <span class="tt-novel-toc-meta">${mountedFloor !== undefined ? `#${mountedFloor}` : `${ch.wordCount}字`}</span>
                        </div>
                        <div class="tt-novel-toc-actions">
                            <button type="button" class="tt-novel-view-btn" data-action="view-orig" data-orig-index="${ch.index}">阅读</button>
                            <button type="button" class="tt-novel-cutoff-btn" data-action="cutoff-here" data-orig-index="${ch.index}">夺舍</button>
                        </div>
                    </div>
                `);
            }
        }

        rows.push(`<div class="tt-novel-toc-divider">✦ AI 续写章节（${aiFloors.length} 章）</div>`);
        if (aiFloors.length === 0) {
            rows.push('<div class="tt-novel-empty">暂无续写章节，在底部发送大纲即可开始续写。</div>');
        } else {
            aiFloors.forEach((item, idx) => {
                if (q && !item.title.toLowerCase().includes(q)) return;
                rows.push(`
                    <div class="tt-novel-toc-item is-ai" data-action="jump-floor" data-floor="${item.floorIdx}">
                        <div class="tt-novel-toc-item-main">
                            <span class="tt-novel-toc-tag ai">续写 ${idx + 1}</span>
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
    };

    paintList('');

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
   TAB 5: ⚙️ 导入与设置 (Clean Grouped Settings & Shared Preset Hub)
   ========================================================================== */
function renderSettingsTab(bodyEl) {
    const settings = handlers.getSettings?.() || {};
    const meta = handlers.getRuntimeMeta?.() || {};
    const canonCount = cachedCanonDb?.items?.length || 0;
    const canonSources = cachedCanonDb?.sources?.join(', ') || '';
    const presetNames = Array.isArray(meta.presetNames) ? meta.presetNames : [];
    const savedPreset = String(settings.distillPresetName ?? '__current__');
    const icon = lastBridgeUi.state === 'connected' ? '🟢' : (lastBridgeUi.state === 'connecting' ? '🟡' : (lastBridgeUi.state === 'error' ? '🔴' : '⚪'));

    const isCustomApi = settings.bgApiMode === 'custom';
    const cachedModels = Array.isArray(settings.bgCustomApiModelsCache) ? settings.bgCustomApiModelsCache : [];
    const customModelVal = String(settings.bgCustomApiModel || '');

    const presetOptions = [
        `<option value="__current__" ${savedPreset === '__current__' ? 'selected' : ''}>使用当前酒馆预设${meta.activePresetName ? `（${escapeHtml(meta.activePresetName)}）` : ''}</option>`,
        `<option value="" ${savedPreset === '' ? 'selected' : ''}>不使用预设（纯净直连）</option>`,
        ...presetNames.map(n => `<option value="${escapeHtml(n)}" ${savedPreset === n ? 'selected' : ''}>${escapeHtml(n)}</option>`),
    ];
    if (savedPreset && savedPreset !== '__current__' && !presetNames.includes(savedPreset)) {
        presetOptions.push(`<option value="${escapeHtml(savedPreset)}" selected>${escapeHtml(savedPreset)}（未找到）</option>`);
    }

    const modelOptionsHtml = cachedModels.length > 0
        ? `
            <select id="tt-novel-wb-custom-model-select" class="text_pole">
                <option value="">-- 从已拉取列表快速选模型（${cachedModels.length}个）--</option>
                ${cachedModels.map(m => `<option value="${escapeHtml(m)}" ${m === customModelVal ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
            </select>
        `
        : '';

    bodyEl.innerHTML = `
        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">📚 导入原著与游戏设定库（对话级独立隔离）</div>
            <div class="tt-novel-action-bar">
                <label class="menu_button tt-novel-file-label tt-novel-btn-primary">
                    <i class="fa-solid fa-file-import"></i> 导入原著 (.txt/.md)
                    <input type="file" id="tt-novel-wb-import-txt" accept=".txt,.md,text/plain,text/markdown,*/*" hidden />
                </label>
                <label class="menu_button tt-novel-file-label">
                    <i class="fa-solid fa-database"></i> 挂载原作/游戏设定库 (.json/.md)
                    <input type="file" id="tt-novel-wb-import-canon" accept=".json,.jsonl,.md,.txt,application/json,text/plain,*/*" multiple hidden />
                </label>
            </div>
            <div class="tt-novel-muted">当前已挂载补充设定词条：${canonCount} 条${canonSources ? `（${escapeHtml(canonSources)}）` : ''}（自带蝴蝶效应保护）</div>
            <div class="tt-novel-action-bar">
                <button type="button" id="tt-novel-wb-clear-canon" class="menu_button tt-novel-btn-sm">清空补充设定库</button>
                <button type="button" id="tt-novel-wb-clear-all" class="menu_button tt-novel-btn-sm">重置当前对话小说数据</button>
            </div>
        </section>

        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">🎛️ 后台任务 API 来源与防拒答预设（蒸馏 / 剧情人物总结 / 去八股共用）</div>
            <div class="tt-novel-inline-field">
                <span>API 来源选择：</span>
                <select id="tt-novel-wb-api-mode" class="text_pole" style="max-width: 240px;">
                    <option value="tavern" ${!isCustomApi ? 'selected' : ''}>酒馆当前 API（${escapeHtml(meta.tavernModel || '跟随顶部连接')}）</option>
                    <option value="custom" ${isCustomApi ? 'selected' : ''}>自定义 OpenAI 兼容 API（独立配置）</option>
                </select>
            </div>
            ${isCustomApi ? `
                <div class="tt-novel-custom-api-box">
                    <div class="tt-novel-edit-grid">
                        <label>Base URL（OpenAI 兼容接口根地址，如 https://api.xxx.com/v1）：
                            <input type="text" id="tt-novel-wb-custom-url" class="text_pole" placeholder="https://api.example.com/v1" value="${escapeHtml(settings.bgCustomApiUrl || '')}" />
                        </label>
                        <label>API Key（通过酒馆本地后端转发，无跨域限制）：
                            <div class="tt-novel-bridge-row">
                                <input type="password" id="tt-novel-wb-custom-key" class="text_pole" placeholder="sk-..." value="${escapeHtml(settings.bgCustomApiKey || '')}" />
                                <button type="button" id="tt-novel-wb-toggle-key" class="menu_button tt-novel-btn-sm" title="显示/隐藏 Key">👁️</button>
                            </div>
                        </label>
                        <label>模型名称（可点右侧按钮自动拉取，也可直接手填）：
                            <div class="tt-novel-bridge-row">
                                <input type="text" id="tt-novel-wb-custom-model" class="text_pole" placeholder="例如 gemini-2.5-pro / deepseek-chat" value="${escapeHtml(customModelVal)}" />
                                <button type="button" id="tt-novel-wb-fetch-models" class="menu_button tt-novel-btn-sm">🔄 拉取模型</button>
                            </div>
                        </label>
                        ${modelOptionsHtml}
                        <div class="tt-novel-inline-field">
                            <span>温度 Temperature (0.0 ~ 1.5)：</span>
                            <input type="number" id="tt-novel-wb-custom-temp" class="text_pole" min="0" max="1.5" step="0.1" value="${Number(settings.bgCustomTemperature ?? 0.7)}" style="width: 78px;" />
                        </div>
                    </div>
                </div>
            ` : `<div class="tt-novel-muted">当前酒馆模型：<code>${escapeHtml(meta.tavernModel || '当前酒馆已连接模型')}</code>（不影响正常聊天续写）</div>`}
            <div class="tt-novel-inline-field">
                <span>共用酒馆预设（套用预设或选纯净直连）：</span>
                <select id="tt-novel-wb-preset-select" class="text_pole" style="max-width: 240px;">${presetOptions.join('')}</select>
            </div>
            <div class="tt-novel-inline-field">
                <span>续写时直接发给 AI 的末尾原著章数 (1~20)：</span>
                <input type="number" id="tt-novel-wb-anchor-count" class="text_pole" min="1" max="20" value="${Number(settings.mountAnchorChapters || 3)}" style="width: 72px;" />
            </div>
        </section>

        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">📖 阅读与续写行为开关</div>
            <label class="checkbox_label"><input type="checkbox" data-setting="enabled" ${settings.enabled ? 'checked' : ''} /><span>启用小说续写插件</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="immersiveMode" ${settings.immersiveMode ? 'checked' : ''} /><span>沉浸小说阅读模式（隐藏头像气泡，连续书页排版）</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="hideUserFloors" ${settings.hideUserFloors ? 'checked' : ''} /><span>隐藏所有「用户指令楼层」</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="hideReasoning" ${settings.hideReasoning !== false ? 'checked' : ''} /><span>隐藏「AI 思维链与思考批注框」</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="authorMode" ${settings.authorMode !== false ? 'checked' : ''} /><span>开启「✍️ 作者境界」（屏蔽玩家 {{user}} 人设，将输入转为导演大纲）</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="foldUserOutlineFloors" ${settings.foldUserOutlineFloors !== false ? 'checked' : ''} /><span>续写完成后自动折叠用户大纲楼层（楼层与章节 1:1 严格对齐）</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="enableAutoStateBlock" ${settings.enableAutoStateBlock ? 'checked' : ''} /><span>单次生成末尾自动产出总结、状态与伏笔更新（depth=0 强化 · 0 额外 API）</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="syncToWorldInfo" ${settings.syncToWorldInfo ? 'checked' : ''} /><span>自动将提取的状态同步写入酒馆原生世界书</span></label>
        </section>

        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">🔌 外部 Agent 远程介入桥 (WebSocket / MCP)</div>
            <div class="tt-novel-bridge-row">
                <input type="text" id="tt-novel-wb-bridge-url" class="text_pole" placeholder="ws://电脑局域网IP:17890/ws" value="${escapeHtml(settings.remoteBridgeUrl || '')}" />
                <button type="button" id="tt-novel-wb-bridge-conn" class="menu_button tt-novel-btn-sm">🔗 连接</button>
                <button type="button" id="tt-novel-wb-bridge-disc" class="menu_button tt-novel-btn-sm">⏹ 断开</button>
            </div>
            <small id="tt-novel-bridge-status" class="tt-novel-bridge-status">${icon} ${escapeHtml(lastBridgeUi.detail)}</small>
        </section>
    `;

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
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 拉取中...';
        try {
            const list = await handlers.onFetchCustomModels?.();
            if (Array.isArray(list) && list.length > 0) {
                globalThis.toastr?.success?.(`已拉取到 ${list.length} 个模型，可在下方下拉框选择！`, '小说续写阅读器');
            } else {
                globalThis.toastr?.warning?.('接口已连上，但未返回模型列表，可直接手动填写模型名', '小说续写阅读器');
            }
        } catch (err) {
            globalThis.toastr?.error?.(`拉取模型失败：${err?.message || err}`, '小说续写阅读器');
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    });

    bodyEl.querySelector('#tt-novel-wb-preset-select')?.addEventListener('change', (e) => {
        handlers.onUpdateSetting?.('distillPresetName', String(e.target.value ?? ''));
        renderWorkbench();
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
            console.warn('[小说续写阅读器] BoundedChatSurface 跳转楼层失败：', err);
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
            console.warn('[小说续写阅读器] 自愈重绘聊天楼层失败：', err);
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
