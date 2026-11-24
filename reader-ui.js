import { escapeHtml, debounce } from '/scripts/utils.js';
import { getContext } from '/scripts/extensions.js';
import { isBoundedChatSurfaceView, jumpBoundedChatSurfaceToMessage, resetChatSurfaceView } from '/script.js';
import { DEFAULT_CLICHE_TERMS } from './cliche-guard.js';
import { isContinuedNovelFloor } from './context-assembler.js';
import { loadCanonDb, loadLedger, loadNovelData, normalizeNarrativeConfig, saveCanonDb, saveLedger } from './storage.js';

const PROGRESS_META_KEY = 'novel_continuation_progress';
const TOC_PAGE_LIMIT = 100;

let workbenchOpen = false;
let activeTab = 'memory';
let memoryFilter = 'all';
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
let cachedAnchorInfo = null;
let handlers = {};

const outlineDraftUiState = {
    userBrief: '',
    chapterCount: 3,
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
                <button type="button" class="tt-novel-wb-tab" data-tab="cliche">🩺 精修重塑<span id="tt-novel-tab-cliche-dot" class="tt-novel-tab-dot displayNone"></span></button>
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
        outlineDraftUiState.chapterCount = Number(saved?.chapterCount || 3);
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
        const settings = handlers.getSettings?.() || {};
        const chPart = cachedNovelData?.totalChapters
            ? `锚点 #${cachedNovelData.cutoffChapterIndex}/${cachedNovelData.totalChapters} · `
            : '';
        const autoTag = settings.autoDeepRewrite ? ' · ⚡自动重塑已开' : '';
        subEl.textContent = `${chPart}模型：${meta.activeModel || '当前酒馆模型'} · 预设：${meta.presetLabel || '当前酒馆预设'}${autoTag}`;
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
    const stopBtn = task.running
        ? `<button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-stop" data-action="stop-task" data-task="${escapeHtml(taskKey)}">⏹ 停止任务</button>`
        : '';
    return `<div class="tt-novel-banner ${cls} tt-novel-banner-row"><span class="tt-novel-banner-text">${escapeHtml(task.text || '任务运行中…')}</span>${stopBtn}</div>`;
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

    const nCfg = normalizeNarrativeConfig(ledger.narrativeConfig);
    const povSummary = nCfg.povMode === 'strict_limited' && nCfg.povCharacter
        ? `严格单视角(${nCfg.povCharacter})`
        : '跟随原著视角';
    const wiSummary = nCfg.worldInfoMode === 'off'
        ? '世界书关闭'
        : (nCfg.worldInfoPriority === 'wi_strict' ? '世界书强一致' : '世界书兜底');
    const refSummary = nCfg.referenceTimelineMode
        ? ` · 🧭对齐基准#${nCfg.referenceCursorChapter || 0}`
        : '';
    const readyMeta = `已挂载：${ledger.characters?.length || 0} 人物 · ${ledger.chronicle?.length || 0} 编年史 · ${openHooks.length} 伏笔 · ${povSummary} · ${wiSummary}${refSummary}`;

    const progressHtml = renderTaskProgressBanner('outline', task);

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
        ? '<div class="tt-novel-empty">尚未生成分章导演大纲。在上方写 1~3 句简略过程与结果，选好规划章数（1~8 章），点「🎬 生成原味导演大纲」即可自动拆分出逐章分镜队列！</div>'
        : savedChapters.map((ch, idx) => `
            <details class="tt-novel-card tt-novel-outline-card ${ch.sent ? 'is-sent' : ''}" data-outline-id="${escapeHtml(ch.id)}" ${(!ch.sent || savedChapters.length <= 2) ? 'open' : ''}>
                <summary class="tt-novel-card-head">
                    <div class="tt-novel-timeline-meta">
                        <span class="tt-novel-chip ${ch.sent ? 'is-ok' : 'is-gold'}">${ch.sent ? '✅ 已发' : `待写 #${idx + 1}`}</span>
                        <strong>${escapeHtml(ch.title || `第 ${ch.chapterIndex} 章`)}</strong>
                    </div>
                    <span class="tt-novel-muted">${String(ch.text || '').length} 字</span>
                </summary>
                <div class="tt-novel-outline-card-body">
                    <textarea class="text_pole tt-novel-style-editor" rows="7" data-outline-text="${escapeHtml(ch.id)}">${escapeHtml(ch.text || '')}</textarea>
                    <div class="tt-novel-action-bar">
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="fill-outline-ch" data-id="${escapeHtml(ch.id)}">
                            📋 填入此章
                        </button>
                        <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="send-outline-ch" data-id="${escapeHtml(ch.id)}">
                            🚀 续写此章
                        </button>
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="toggle-outline-sent" data-id="${escapeHtml(ch.id)}">
                            ${ch.sent ? '↩️ 标为待写' : '✅ 标为已写'}
                        </button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="move-outline-up" data-id="${escapeHtml(ch.id)}" title="上移" ${idx === 0 ? 'disabled' : ''}>⬆️</button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="move-outline-down" data-id="${escapeHtml(ch.id)}" title="下移" ${idx === savedChapters.length - 1 ? 'disabled' : ''}>⬇️</button>
                        <button type="button" class="tt-novel-mini-icon-btn" data-action="del-outline-ch" data-id="${escapeHtml(ch.id)}" title="删除此章大纲">🗑️</button>
                    </div>
                </div>
            </details>
        `).join('');

    bodyEl.innerHTML = `
        <div class="tt-novel-banner">
            <div><b>📍 ${escapeHtml(anchorText)}</b></div>
            <div class="tt-novel-muted">${escapeHtml(readyMeta)}</div>
        </div>

        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">📝 输入简略过程与结果（可一次规划 1~8 章连贯卷纲，逐章点击续写）</div>
            <textarea id="tt-novel-outline-brief" class="text_pole" rows="3" placeholder="例如：出海前博士来试探但没挑破照片，设备修好顺手碰一下帘子后门的伏笔；随后登船出海遇远海黑雾白光，凯尔希察觉秘宝漏洞但暂时稳住，最后抵达核心海域。&#10;（也可以留空，点下方「🎲 留空自动构思」让 AI 顺着当前伏笔直接给方案！）">${escapeHtml(outlineDraftUiState.userBrief || '')}</textarea>
            <div class="tt-novel-row-3">
                <label class="tt-novel-muted">规划章数：
                    <select id="tt-novel-outline-chapters" class="text_pole">
                        <option value="1" ${Number(outlineDraftUiState.chapterCount) === 1 ? 'selected' : ''}>1 章（单章精细）</option>
                        <option value="2" ${Number(outlineDraftUiState.chapterCount) === 2 ? 'selected' : ''}>2 章（上下连篇）</option>
                        <option value="3" ${Number(outlineDraftUiState.chapterCount || 3) === 3 ? 'selected' : ''}>3 章（小高潮篇·推荐）</option>
                        <option value="5" ${Number(outlineDraftUiState.chapterCount) === 5 ? 'selected' : ''}>5 章（完整卷纲）</option>
                        <option value="8" ${Number(outlineDraftUiState.chapterCount) === 8 ? 'selected' : ''}>8 章（长线规划）</option>
                    </select>
                </label>
                <label class="tt-novel-muted">每章切镜：
                    <select id="tt-novel-outline-scenes" class="text_pole">
                        <option value="3" ${Number(outlineDraftUiState.sceneCount) === 3 ? 'selected' : ''}>3 镜头（紧凑）</option>
                        <option value="4" ${Number(outlineDraftUiState.sceneCount || 4) === 4 ? 'selected' : ''}>4 镜头（原著标准）</option>
                        <option value="5" ${Number(outlineDraftUiState.sceneCount) === 5 ? 'selected' : ''}>5 镜头（多线交替）</option>
                    </select>
                </label>
                <label class="tt-novel-muted">推进步幅：
                    <select id="tt-novel-outline-pace" class="text_pole">
                        <option value="slow" ${outlineDraftUiState.paceMode === 'slow' ? 'selected' : ''}>温水煮青蛙（稳步铺垫）</option>
                        <option value="medium" ${outlineDraftUiState.paceMode === 'medium' ? 'selected' : ''}>中速推进（小冲突升级）</option>
                        <option value="climax" ${outlineDraftUiState.paceMode === 'climax' ? 'selected' : ''}>高潮爆点（回收关键伏笔）</option>
                    </select>
                </label>
            </div>
            <details class="tt-novel-fold-card" ${openHooks.length <= 8 ? 'open' : ''}>
                <summary>🎯 勾选本次规划想沾边或推进的伏笔（已选 ${selectedHookSet.size} / ${openHooks.length}，多章规划会自动均摊到各章）</summary>
                <div style="margin-top: 6px;">${hookPickerHtml}</div>
            </details>
            <div class="tt-novel-action-bar">
                <button type="button" id="tt-novel-outline-generate" class="menu_button tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                    🎬 生成 ${Number(outlineDraftUiState.chapterCount || 3)} 章原味导演大纲 (1次API · 套预设)
                </button>
                <button type="button" id="tt-novel-outline-auto" class="menu_button" ${task.running ? 'disabled' : ''}>
                    🎲 留空自动构思 ${Number(outlineDraftUiState.chapterCount || 3)} 章
                </button>
            </div>
        </section>

        ${progressHtml}

        <section class="tt-novel-section">
            <div class="tt-novel-card-head">
                <div class="tt-novel-section-title">📋 分章导演大纲队列（共 ${savedChapters.length} 章 · 可逐章微调并一键续写）</div>
                <div class="tt-novel-card-actions">
                    <button type="button" id="tt-novel-outline-add-ch" class="menu_button tt-novel-btn-sm">+ 新增一章</button>
                    ${savedChapters.length > 0 ? '<button type="button" id="tt-novel-outline-save-all" class="menu_button tt-novel-btn-sm">💾 保存全部修改</button>' : ''}
                </div>
            </div>
            <div class="tt-novel-card-stack">${chapterCardsHtml}</div>
        </section>
    `;

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
        globalThis.toastr?.success?.('已保存全部章节大纲修改！', '小说续写阅读器');
    });

    bodyEl.querySelectorAll('[data-action="fill-outline-ch"], [data-action="send-outline-ch"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const autoSend = btn.getAttribute('data-action') === 'send-outline-ch';
            const edited = collectEditedChapters();
            const target = edited.find(c => c.id === id);
            if (!target || !target.text) {
                globalThis.toastr?.warning?.('该章大纲为空', '小说续写阅读器');
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
        const title = window.prompt('请输入新增大纲章节标题（可留空使用默认）：', `第 ${nextIdx} ${unit} · 新剧情`);
        if (title === null) return;
        edited.push({
            id: `outline_ch_manual_${Date.now()}`,
            chapterIndex: nextIdx,
            title: title.trim() || `第 ${nextIdx} ${unit}`,
            text: `【${title.trim() || `第 ${nextIdx} ${unit}`} 分镜大纲】\n1. （时间·地点）`,
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

/* ==========================================================================
   TAB 1: 📚 剧情与人物 (LittleWhiteBox-Style Structured Memory Dashboard)
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

    const progressHtml = renderTaskProgressBanner('memory', task);

    const povBadge = nCfg.povMode === 'strict_limited' && nCfg.povCharacter
        ? `🔒 单视角：${nCfg.povCharacter}`
        : '👁️ 跟随原著视角';
    const refBadge = nCfg.referenceTimelineMode
        ? ` · 🧭 基准对齐#${nCfg.referenceCursorChapter || 0}`
        : '';
    const wiBadge = nCfg.worldInfoMode === 'off'
        ? '🌐 后台世界书：关'
        : `🌐 后台世界书：${nCfg.worldInfoPriority === 'wi_strict' ? '严格遵循世界书' : '小说优先·世界书兜底'}`;

    const narrativeConfigHtml = `
        <details class="tt-novel-fold-card tt-novel-narrative-box">
            <summary>
                🧭 本书叙事视角、时间线与世界书规则（${escapeHtml(povBadge)}${escapeHtml(refBadge)} · ${escapeHtml(wiBadge)}）
            </summary>
            <div class="tt-novel-edit-grid" style="margin-top: 8px;">
                <div class="tt-novel-row-3">
                    <label>叙事视角模式：
                        <select id="tt-novel-ncfg-pov-mode" class="text_pole">
                            <option value="auto" ${nCfg.povMode === 'auto' ? 'selected' : ''}>自动 / 跟随原著（兼容多视角）</option>
                            <option value="strict_limited" ${nCfg.povMode === 'strict_limited' ? 'selected' : ''}>严格限制单视角（Limited POV）</option>
                        </select>
                    </label>
                    <label>锁定视角人物（单视角必填）：
                        <input type="text" id="tt-novel-ncfg-pov-char" class="text_pole" value="${escapeHtml(nCfg.povCharacter || '')}" placeholder="例如：博士 / 我 / 主角名" />
                    </label>
                    <label>单视角人称：
                        <select id="tt-novel-ncfg-pov-person" class="text_pole">
                            <option value="follow_original" ${nCfg.povPerson === 'follow_original' ? 'selected' : ''}>跟随原著人称</option>
                            <option value="first_person" ${nCfg.povPerson === 'first_person' ? 'selected' : ''}>第一人称（“我”）</option>
                            <option value="third_limited" ${nCfg.povPerson === 'third_limited' ? 'selected' : ''}>第三人称限制视角</option>
                        </select>
                    </label>
                </div>
                <div class="tt-novel-row-3">
                    <label>后台任务贯通酒馆世界书：
                        <select id="tt-novel-ncfg-wi-mode" class="text_pole">
                            <option value="bridge" ${nCfg.worldInfoMode !== 'off' ? 'selected' : ''}>开启（重塑/大纲/归档自动读取）</option>
                            <option value="off" ${nCfg.worldInfoMode === 'off' ? 'selected' : ''}>关闭（仅用插件台账与补充库）</option>
                        </select>
                    </label>
                    <label>世界书与小说设定冲突时：
                        <select id="tt-novel-ncfg-wi-priority" class="text_pole">
                            <option value="novel_over_wi" ${nCfg.worldInfoPriority !== 'wi_strict' ? 'selected' : ''}>小说改写优先，世界书兜底（不混穿）</option>
                            <option value="wi_strict" ${nCfg.worldInfoPriority === 'wi_strict' ? 'selected' : ''}>严格遵循酒馆世界书（外观/常服锁死）</option>
                        </select>
                    </label>
                    <label>后台世界书最大注入字数：
                        <input type="number" id="tt-novel-ncfg-wi-budget" class="text_pole" min="2000" max="40000" step="1000" value="${Number(nCfg.worldInfoBudgetChars || 12000)}" />
                    </label>
                </div>
                <div class="tt-novel-row-2">
                    <label class="tt-novel-check-row">
                        <input type="checkbox" id="tt-novel-ncfg-strict-tl" ${nCfg.strictTimelineOrder !== false ? 'checked' : ''} />
                        <span>严格单向推进时间线（禁止大纲/正文倒流或重复已发生重大桥段）</span>
                    </label>
                    <label class="tt-novel-check-row">
                        <input type="checkbox" id="tt-novel-ncfg-skip-fb" ${nCfg.excludeFlashbackFromAnchor !== false ? 'checked' : ''} />
                        <span>续写锚点与检索自动跳过「倒叙/插叙」章节（可在「📑 目录」按区间标注）</span>
                    </label>
                </div>
                <div class="tt-novel-custom-api-box">
                    <label class="tt-novel-check-row" style="margin-bottom: 6px;">
                        <input type="checkbox" id="tt-novel-ncfg-ref-mode" ${nCfg.referenceTimelineMode ? 'checked' : ''} />
                        <span><b>🧭 启用「平行视角 · 对照已完结基准时间线」模式</b>（适合“A视角已完结、续写B视角太监线”：先在「📑 目录」把已完结A视角区间标为「🧭 基准时间线」，再填写当前已对齐的基准章号）</span>
                    </label>
                    <div class="tt-novel-row-3">
                        <label>基准时间线名称：
                            <input type="text" id="tt-novel-ncfg-ref-label" class="text_pole" value="${escapeHtml(nCfg.referencePovLabel || '')}" placeholder="例如：博士视角原著" />
                        </label>
                        <label>当前已对齐基准章号（Cursor）：
                            <input type="number" id="tt-novel-ncfg-ref-cursor" class="text_pole" min="0" value="${Number(nCfg.referenceCursorChapter || 0)}" />
                        </label>
                        <label>前方基准路标视野（章数）：
                            <input type="number" id="tt-novel-ncfg-ref-window" class="text_pole" min="2" max="20" value="${Number(nCfg.referenceLookaheadChapters || 8)}" />
                        </label>
                    </div>
                </div>
                <div class="tt-novel-action-bar">
                    <button type="button" id="tt-novel-ncfg-save" class="menu_button tt-novel-btn-sm tt-novel-btn-primary">💾 保存本书叙事与世界书规则</button>
                </div>
            </div>
        </details>
    `;

    const failedRangeText = failedBatches.map(b => `第${b.startChapter}~${b.endChapter}章`).join('、');
    const sliceManagerHtml = batches.length > 0
        ? `
        <details class="tt-novel-fold-card tt-novel-slice-box" ${(failedBatches.length > 0 || ledger.archiveNeedsResynth) ? 'open' : ''}>
            <summary>
                🧩 分批切片管理（共 ${batches.length} 片 · ✅ ${okBatchCount} 正常${failedBatches.length > 0 ? ` · ⚠️ ${failedBatches.length} 道歉/失败` : ''}）
            </summary>
            <div class="tt-novel-slice-body">
                ${failedBatches.length > 0 ? `<div class="tt-novel-banner is-warn">⚠️ 以下切片疑似模型道歉或失败，尚未纳入总账：<b>${escapeHtml(failedRangeText)}</b>。可直接在下方点「🔄 重跑此切片」，或去「⚙️ 设置」换自定义 API / 调整预设后再重跑！</div>` : ''}
                ${ledger.archiveNeedsResynth ? '<div class="tt-novel-banner is-running">💡 已有切片完成更新，请点击下方「🔁 用当前切片重新合稿总账」将新内容合并进编年史与人物卡。</div>' : ''}
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
        ? '<div class="tt-novel-empty">尚未生成核心人物档案。点击上方「📚 全本通读归档」自动按原著提取 4 维灵魂与防 OOC 红线，或点「+ 人物」手动新增。</div>'
        : chars.map(ch => {
            if (editingCharacterId === ch.id) {
                return `
                    <div class="tt-novel-card tt-novel-char-card is-editing" data-char-id="${escapeHtml(ch.id)}">
                        <div class="tt-novel-edit-grid">
                            <input type="text" class="text_pole" data-field="name" value="${escapeHtml(ch.name)}" placeholder="人物姓名" />
                            <input type="text" class="text_pole" data-field="role" value="${escapeHtml(ch.role || '')}" placeholder="身份定位" />
                            <label>👔 当前外观与着装锚点（续写与重塑强制保持一致）：<textarea class="text_pole" rows="2" data-field="currentAppearance" placeholder="发色/瞳色/当前日常服装与配饰...">${escapeHtml(ch.currentAppearance || '')}</textarea></label>
                            <label>🎮 原作/世界观设定底骨与能力：<textarea class="text_pole" rows="2" data-field="canonFoundation">${escapeHtml(ch.canonFoundation || '')}</textarea></label>
                            <label>🎭 当前处境与关系：<textarea class="text_pole" rows="2" data-field="currentSituation">${escapeHtml(ch.currentSituation || '')}</textarea></label>
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
                    ${ch.currentAppearance ? `<div class="tt-novel-char-row is-appear"><span>👔 当前着装</span><p>${escapeHtml(ch.currentAppearance)}</p></div>` : ''}
                    ${ch.canonFoundation ? `<div class="tt-novel-char-row is-canon"><span>🎮 原作底骨</span><p>${escapeHtml(ch.canonFoundation)}</p></div>` : ''}
                    ${ch.currentSituation ? `<div class="tt-novel-char-row is-sit"><span>🎭 当前处境</span><p>${escapeHtml(ch.currentSituation)}</p></div>` : ''}
                    ${ch.voiceAndQuotes ? `<div class="tt-novel-char-row is-voice"><span>🗣️ 言行原话</span><p>${escapeHtml(ch.voiceAndQuotes)}</p></div>` : ''}
                    ${ch.oocRedLines ? `<div class="tt-novel-char-row is-ooc"><span>🚫 OOC红线</span><p>${escapeHtml(ch.oocRedLines)}</p></div>` : ''}
                </div>
            `;
        }).join('');

    const chronicleHtml = chronicle.length === 0
        ? '<div class="tt-novel-empty">暂无全本剧情编年史。可点「📚 全本通读归档」自动生成，或点「+ 事件」手动录入。</div>'
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
                                    <option value="reference" ${evt.timelinePhase === 'reference' ? 'selected' : ''}>🧭 基准时间线</option>
                                    <option value="flashback" ${evt.timelinePhase === 'flashback' ? 'selected' : ''}>⏪ 倒叙/插叙</option>
                                </select>
                            </div>
                            <div class="tt-novel-row-2">
                                <input type="text" class="text_pole" data-field="title" value="${escapeHtml(evt.title || '')}" placeholder="事件标题" />
                                <input type="text" class="text_pole" data-field="pov" value="${escapeHtml(evt.pov || '')}" placeholder="叙事视角（可留空）" />
                            </div>
                            <input type="text" class="text_pole" data-field="participants" value="${escapeHtml((evt.participants || []).join('、'))}" placeholder="出场人物（顿号分隔）" />
                            <textarea class="text_pole" rows="3" data-field="summary" placeholder="客观剧情经过与结果">${escapeHtml(evt.summary || '')}</textarea>
                            <input type="text" class="text_pole" data-field="infoGap" value="${escapeHtml(evt.infoGap || '')}" placeholder="通用信息差（谁还不知道什么）" />
                            <input type="text" class="text_pole" data-field="povKnown" value="${escapeHtml(evt.povKnown || '')}" placeholder="主视角人物明确已知的事实（单视角模式可选）" />
                            <input type="text" class="text_pole" data-field="povBlindspot" value="${escapeHtml(evt.povBlindspot || '')}" placeholder="主视角盲区/幕后黑盒（严禁切视角或未卜先知）" />
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
                            ${evt.timelinePhase === 'reference' ? '<span class="tt-novel-chip is-ok">🧭 基准线</span>' : (evt.timelinePhase === 'flashback' ? '<span class="tt-novel-chip is-warn">倒叙/插叙</span>' : '')}
                            ${evt.pov ? `<span class="tt-novel-chip">视角:${escapeHtml(evt.pov)}</span>` : ''}
                            <strong>${escapeHtml(evt.title)}</strong>
                            ${evt.timeLabel ? `<span class="tt-novel-muted">${escapeHtml(evt.timeLabel)}</span>` : ''}
                        </div>
                        <div class="tt-novel-card-actions">
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-evt" data-id="${escapeHtml(evt.id)}" title="编辑事件">✏️</button>
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="del-evt" data-id="${escapeHtml(evt.id)}" title="删除事件">🗑️</button>
                        </div>
                    </div>
                    ${(evt.participants || []).length > 0 ? `<div class="tt-novel-chip-row">${evt.participants.map(p => `<span class="tt-novel-chip">${escapeHtml(p)}</span>`).join('')}</div>` : ''}
                    <div class="tt-novel-card-text">${escapeHtml(evt.summary)}</div>
                    ${evt.povKnown ? `<div class="tt-novel-infogap">👁️ 视角已知：${escapeHtml(evt.povKnown)}</div>` : ''}
                    ${evt.povBlindspot ? `<div class="tt-novel-infogap">🔒 幕后黑盒：${escapeHtml(evt.povBlindspot)}</div>` : ''}
                    ${evt.infoGap ? `<div class="tt-novel-infogap">🔍 信息差：${escapeHtml(evt.infoGap)}</div>` : ''}
                </div>
            `;
        }).join('');

    const renderHookItem = (h) => {
        if (editingHookId === h.id) {
            return `
                <div class="tt-novel-card is-editing" data-hook-id="${escapeHtml(h.id)}">
                    <div class="tt-novel-edit-grid">
                        <div class="tt-novel-row-2">
                            <input type="number" class="text_pole" data-field="plantedChapter" min="1" value="${Number(h.plantedChapter || 1)}" placeholder="埋下章号" />
                            <select class="text_pole" data-field="status">
                                <option value="open" ${h.status === 'open' ? 'selected' : ''}>🔮 长期暗线</option>
                                <option value="pinned" ${h.status === 'pinned' ? 'selected' : ''}>🎯 本章重点推进</option>
                                <option value="resolved" ${h.status === 'resolved' ? 'selected' : ''}>✅ 已回收</option>
                            </select>
                        </div>
                        <textarea class="text_pole" rows="2" data-field="content" placeholder="伏笔内容">${escapeHtml(h.content || '')}</textarea>
                    </div>
                    <div class="tt-novel-card-actions">
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="save-hook" data-id="${escapeHtml(h.id)}">💾 保存</button>
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-hook">取消</button>
                    </div>
                </div>
            `;
        }
        return `
            <div class="tt-novel-hook-row ${h.status === 'pinned' ? 'is-pinned' : ''} ${h.status === 'resolved' ? 'is-resolved' : ''}">
                <div class="tt-novel-hook-text">
                    <span class="tt-novel-chip">#${Number(h.plantedChapter || 1)}</span>
                    <span>${escapeHtml(h.content)}</span>
                    ${h.resolvedChapter ? `<span class="tt-novel-muted">（已于第${h.resolvedChapter}章回收）</span>` : ''}
                </div>
                <div class="tt-novel-card-actions">
                    ${h.status !== 'resolved' ? `<button type="button" class="tt-novel-mini-icon-btn" data-action="pin-hook" data-id="${escapeHtml(h.id)}" title="切换是否本章重点推进">${h.status === 'pinned' ? '🎯' : '📌'}</button>` : ''}
                    <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-hook" data-id="${escapeHtml(h.id)}" title="编辑伏笔">✏️</button>
                    <button type="button" class="tt-novel-mini-icon-btn" data-action="resolve-hook" data-id="${escapeHtml(h.id)}" title="${h.status === 'resolved' ? '重新打开伏笔' : '标记已填坑'}">${h.status === 'resolved' ? '↩️' : '✅'}</button>
                    <button type="button" class="tt-novel-mini-icon-btn" data-action="del-hook" data-id="${escapeHtml(h.id)}" title="删除伏笔">🗑️</button>
                </div>
            </div>
        `;
    };

    const hooksHtml = hooks.length === 0
        ? '<div class="tt-novel-empty">暂无伏笔记录。续写时会自动通过末段指令提取新伏笔与已填坑，也可以点击上方「+ 伏笔」手动埋线。</div>'
        : `
            ${openHooks.map(renderHookItem).join('')}
            ${resolvedHooks.length > 0 ? `<details class="tt-novel-fold-card"><summary>已回收伏笔（${resolvedHooks.length}）</summary>${resolvedHooks.map(renderHookItem).join('')}</details>` : ''}
        `;

    const worldRowsHtml = worldStates.map((w, idx) => {
        const wsId = w.id || `ws_idx_${idx}`;
        if (editingWorldStateId === wsId) {
            return `
                <div class="tt-novel-card is-editing" data-ws-id="${escapeHtml(wsId)}">
                    <div class="tt-novel-edit-grid">
                        <div class="tt-novel-row-3">
                            <input type="text" class="text_pole" data-field="category" value="${escapeHtml(w.category || '人物')}" placeholder="分类（人物/外观/物品/势力）" />
                            <input type="text" class="text_pole" data-field="name" value="${escapeHtml(w.name || '')}" placeholder="条目名" />
                            <input type="number" class="text_pole" data-field="effectiveChapter" min="1" value="${Number(w.effectiveChapter || 1)}" placeholder="生效章号" />
                        </div>
                        <textarea class="text_pole" rows="2" data-field="state" placeholder="最新状态描述">${escapeHtml(w.state || '')}</textarea>
                    </div>
                    <div class="tt-novel-card-actions">
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="save-ws" data-id="${escapeHtml(wsId)}">💾 保存</button>
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-ws">取消</button>
                    </div>
                </div>
            `;
        }
        return `
            <div class="tt-novel-state-row tt-novel-state-crud-row">
                <div class="tt-novel-state-main">
                    <span class="tt-novel-chip">[${escapeHtml(w.category || '状态')}] ${escapeHtml(w.name)}</span>
                    <span class="tt-novel-muted">#${Number(w.effectiveChapter || 1)}</span>
                    <span>${escapeHtml(w.state)}</span>
                </div>
                <div class="tt-novel-card-actions">
                    <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-ws" data-id="${escapeHtml(wsId)}" title="编辑状态">✏️</button>
                    <button type="button" class="tt-novel-mini-icon-btn" data-action="del-ws" data-id="${escapeHtml(wsId)}" title="删除状态">🗑️</button>
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
                        <textarea class="text_pole" rows="2" data-field="summary" placeholder="单章摘要">${escapeHtml(sum.summary || '')}</textarea>
                    </div>
                    <div class="tt-novel-card-actions">
                        <button type="button" class="menu_button tt-novel-btn-sm" data-action="save-sum" data-ch="${chNum}">💾 保存</button>
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
                    <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-sum" data-ch="${chNum}" title="编辑摘要">✏️</button>
                    <button type="button" class="tt-novel-mini-icon-btn" data-action="del-sum" data-ch="${chNum}" title="删除摘要">🗑️</button>
                </div>
            </div>
        `;
    }).join('');

    const worldAndSumsHtml = (worldStates.length === 0 && summaries.length === 0)
        ? '<div class="tt-novel-empty">暂无势力/物品状态或单章续写摘要。可点下方按钮手动新增。</div>'
        : `
            ${worldStates.length > 0 ? `<div class="tt-novel-chip-list">${worldRowsHtml}</div>` : ''}
            ${summaries.length > 0 ? `<div class="tt-novel-subhead">📝 续写单章摘要（${summaries.length}）</div><div class="tt-novel-chip-list">${summaryRowsHtml}</div>` : ''}
        `;

    const canonQ = canonSearchQuery.trim().toLowerCase();
    const filteredCanon = canonQ
        ? canonItems.filter(it =>
            `${it.title || ''} ${it.category || ''} ${(it.keywords || []).join(' ')} ${it.content || ''}`.toLowerCase().includes(canonQ),
        )
        : canonItems;
    const canonHtml = canonItems.length === 0
        ? '<div class="tt-novel-empty">当前补充设定库为空。可在「⚙️ 设置」批量导入 JSON/TXT 设定集，或点「+ 新增设定」手动添加单条世界观/外传设定。</div>'
        : (filteredCanon.length === 0
            ? '<div class="tt-novel-empty">未匹配到符合关键词的设定条目。</div>'
            : filteredCanon.slice(0, 60).map(it => {
                if (editingCanonId === it.id) {
                    return `
                        <div class="tt-novel-card is-editing" data-canon-id="${escapeHtml(it.id)}">
                            <div class="tt-novel-edit-grid">
                                <div class="tt-novel-row-2">
                                    <input type="text" class="text_pole" data-field="title" value="${escapeHtml(it.title || '')}" placeholder="设定标题" />
                                    <input type="text" class="text_pole" data-field="category" value="${escapeHtml(it.category || '原作设定')}" placeholder="分类" />
                                </div>
                                <input type="text" class="text_pole" data-field="keywords" value="${escapeHtml((it.keywords || []).join('、'))}" placeholder="触发关键词（顿号/逗号分隔）" />
                                <textarea class="text_pole" rows="3" data-field="content" placeholder="设定内容">${escapeHtml(it.content || '')}</textarea>
                            </div>
                            <div class="tt-novel-card-actions">
                                <button type="button" class="menu_button tt-novel-btn-sm" data-action="save-canon" data-id="${escapeHtml(it.id)}">💾 保存</button>
                                <button type="button" class="menu_button tt-novel-btn-sm" data-action="cancel-canon">取消</button>
                            </div>
                        </div>
                    `;
                }
                return `
                    <div class="tt-novel-card">
                        <div class="tt-novel-card-head">
                            <div class="tt-novel-timeline-meta">
                                <span class="tt-novel-chip">${escapeHtml(it.category || '原作设定')}</span>
                                <strong>${escapeHtml(it.title || '未命名设定')}</strong>
                            </div>
                            <div class="tt-novel-card-actions">
                                <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-canon" data-id="${escapeHtml(it.id)}" title="编辑设定">✏️</button>
                                <button type="button" class="tt-novel-mini-icon-btn" data-action="del-canon" data-id="${escapeHtml(it.id)}" title="删除设定">🗑️</button>
                            </div>
                        </div>
                        ${(it.keywords || []).length > 0 ? `<div class="tt-novel-chip-row">${it.keywords.slice(0, 8).map(k => `<span class="tt-novel-chip is-gold">${escapeHtml(k)}</span>`).join('')}</div>` : ''}
                        <div class="tt-novel-card-text">${escapeHtml(String(it.content || '').slice(0, 320))}${String(it.content || '').length > 320 ? '……' : ''}</div>
                    </div>
                `;
            }).join(''));

    const showChars = memoryFilter === 'all' || memoryFilter === 'chars';
    const showChronicle = memoryFilter === 'all' || memoryFilter === 'chronicle';
    const showHooks = memoryFilter === 'all' || memoryFilter === 'hooks';
    const showWorld = memoryFilter === 'all' || memoryFilter === 'world';
    const showCanon = memoryFilter === 'canon';

    bodyEl.innerHTML = `
        <div class="tt-novel-action-bar">
            <button type="button" id="tt-novel-run-archive-full" class="menu_button tt-novel-btn-primary" ${task.running ? 'disabled' : ''}>
                📚 全本通读归档 (并发≤2 · 套预设)
            </button>
            <button type="button" id="tt-novel-run-archive-inc" class="menu_button" ${task.running ? 'disabled' : ''}>
                ⚡ 增量补总结新章
            </button>
            <button type="button" id="tt-novel-add-char" class="menu_button">+ 人物</button>
            <button type="button" id="tt-novel-add-evt" class="menu_button">+ 事件</button>
            <button type="button" id="tt-novel-add-hook" class="menu_button">+ 伏笔</button>
            <button type="button" id="tt-novel-add-ws" class="menu_button">+ 状态</button>
            <button type="button" id="tt-novel-add-canon" class="menu_button">+ 设定</button>
        </div>
        ${narrativeConfigHtml}
        <div class="tt-novel-subfilter">
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'all' ? 'active' : ''}" data-filter="all">全部总览</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'chars' ? 'active' : ''}" data-filter="chars">👤 人物 (${chars.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'chronicle' ? 'active' : ''}" data-filter="chronicle">📜 编年史 (${chronicle.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'hooks' ? 'active' : ''}" data-filter="hooks">🎯 伏笔 (${openHooks.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'world' ? 'active' : ''}" data-filter="world">🌍 状态 (${worldStates.length + summaries.length})</button>
            <button type="button" class="tt-novel-filter-pill ${memoryFilter === 'canon' ? 'active' : ''}" data-filter="canon">📖 设定库 (${canonItems.length})</button>
        </div>
        ${progressHtml}
        ${sliceManagerHtml}
        ${logHtml}
        ${showChars ? `<section class="tt-novel-section"><div class="tt-novel-section-title">👤 核心人物 4 维灵魂、当前着装与防 OOC 档案（已归档至第 ${ledger.lastArchivedChapter || 0} 章）</div><div class="tt-novel-card-grid">${charCardsHtml}</div></section>` : ''}
        ${showChronicle ? `<section class="tt-novel-section"><div class="tt-novel-section-title">📜 全本剧情编年史（无 RP 标签 · 保留视角与信息差）</div><div class="tt-novel-card-stack">${chronicleHtml}</div></section>` : ''}
        ${showHooks ? `<section class="tt-novel-section"><div class="tt-novel-section-title">🎯 伏笔与暗线追踪（点 🎯 设为本章重点推进 · 点 ✏️ 修改）</div><div class="tt-novel-card-stack">${hooksHtml}</div></section>` : ''}
        ${showWorld ? `
            <section class="tt-novel-section">
                <div class="tt-novel-card-head">
                    <div class="tt-novel-section-title">🌍 势力 / 物品 / 外观 / 单章状态记录</div>
                    <div class="tt-novel-card-actions">
                        <button type="button" id="tt-novel-add-ws-inline" class="menu_button tt-novel-btn-sm">+ 状态</button>
                        <button type="button" id="tt-novel-add-sum-inline" class="menu_button tt-novel-btn-sm">+ 单章摘要</button>
                    </div>
                </div>
                <div class="tt-novel-card-stack">${worldAndSumsHtml}</div>
            </section>
        ` : ''}
        ${showCanon ? `
            <section class="tt-novel-section">
                <div class="tt-novel-card-head">
                    <div class="tt-novel-section-title">📖 补充设定数据库（共 ${canonItems.length} 条 · 显示 ${Math.min(filteredCanon.length, 60)} 条）</div>
                    <button type="button" id="tt-novel-add-canon-inline" class="menu_button tt-novel-btn-sm">+ 新增设定</button>
                </div>
                <input type="search" id="tt-novel-canon-search" class="text_pole" value="${escapeHtml(canonSearchQuery)}" placeholder="搜索设定标题、分类或关键词..." style="margin-bottom: 8px;" />
                <div class="tt-novel-card-stack">${canonHtml}</div>
            </section>
        ` : ''}
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
        };
        if (patch.povMode === 'strict_limited' && !patch.povCharacter) {
            globalThis.toastr?.warning?.('已选「严格限制单视角」，请填写视角人物名称（如主角名）', '小说续写阅读器');
            return;
        }
        await handlers.onUpdateNarrativeConfig?.(patch);
        globalThis.toastr?.success?.('已保存本书叙事视角、时间线与世界书规则！', '小说续写阅读器');
    });

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
            currentAppearance: '',
            currentSituation: '',
            voiceAndQuotes: '',
            oocRedLines: '',
            updatedChapter: Number(cachedNovelData?.cutoffChapterIndex || 1),
        };
        cur.characters.push(newChar);
        await saveLedger(cur);
        editingCharacterId = newChar.id;
        if (memoryFilter !== 'all' && memoryFilter !== 'chars') memoryFilter = 'chars';
        await refreshReaderWidgets();
    });

    bodyEl.querySelector('#tt-novel-add-evt')?.addEventListener('click', async () => {
        const title = window.prompt('请输入新增编年史事件标题：');
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
        if (memoryFilter !== 'all' && memoryFilter !== 'chronicle') memoryFilter = 'chronicle';
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

    const addWorldStateFlow = async () => {
        const name = window.prompt('请输入状态条目名（例如角色名、物品名或势力名）：');
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
    };
    bodyEl.querySelector('#tt-novel-add-ws')?.addEventListener('click', addWorldStateFlow);
    bodyEl.querySelector('#tt-novel-add-ws-inline')?.addEventListener('click', addWorldStateFlow);

    bodyEl.querySelector('#tt-novel-add-sum-inline')?.addEventListener('click', async () => {
        const rawCh = window.prompt('请输入摘要对应的章号：', String(Number(cachedNovelData?.cutoffChapterIndex || 1) + 1));
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

    const addCanonFlow = async () => {
        const title = window.prompt('请输入新增设定条目标题：');
        if (!title || !title.trim()) return;
        const curCanon = await loadCanonDb();
        const newItem = {
            id: `canon_manual_${Date.now()}`,
            title: title.trim(),
            category: '原作设定',
            keywords: [title.trim()],
            content: '',
            source: '手动录入',
        };
        curCanon.items.unshift(newItem);
        await saveCanonDb(curCanon);
        editingCanonId = newItem.id;
        memoryFilter = 'canon';
        await refreshReaderWidgets();
    };
    bodyEl.querySelector('#tt-novel-add-canon')?.addEventListener('click', addCanonFlow);
    bodyEl.querySelector('#tt-novel-add-canon-inline')?.addEventListener('click', addCanonFlow);

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
                target.category = val('category') || '原作设定';
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

    const progressHtml = renderTaskProgressBanner('style', task);

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
   TAB 3: 🩺 精修重塑 (Auto/Manual 5-Step Deep Rewrite + Zero-API Cliché Audit)
   ========================================================================== */
function renderClicheTab(bodyEl) {
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

    let rewriteModelConfigHtml = `<div class="tt-novel-muted">当前重塑将跟随后台设置：<code>${escapeHtml(meta.activeModel || '当前酒馆模型')}</code> · 预设：<code>${escapeHtml(meta.presetLabel || '当前酒馆预设')}</code></div>`;
    if (rewriteMode === 'tavern_override') {
        const selectHtml = tavernModels.length > 0
            ? `
                <select id="tt-novel-rw-tavern-select" class="text_pole">
                    <option value="">-- 从酒馆当前连接已拉取模型中速选（${tavernModels.length}个）--</option>
                    ${tavernModels.map(m => `<option value="${escapeHtml(m)}" ${m === savedRewriteTavernModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
                </select>
            `
            : '';
        rewriteModelConfigHtml = `
            <div class="tt-novel-custom-api-box">
                <div class="tt-novel-edit-grid">
                    <div class="tt-novel-muted">💡 复用酒馆当前接口地址与密钥，只在重写这一步临时切换模型名（例如主聊天用 <code>Gemini4h</code> 写初稿，此处填 <code>Gemini4a / gemini-4-argon</code> 自动重写）。</div>
                    <label>重塑专用模型名（直接手填或从下方速选）：
                        <input type="text" id="tt-novel-rw-tavern-model" class="text_pole" placeholder="例如 gemini-4-argon / gemini-2.5-pro" value="${escapeHtml(savedRewriteTavernModel)}" />
                    </label>
                    ${selectHtml}
                </div>
            </div>
        `;
    } else if (rewriteMode === 'custom') {
        const customSelectHtml = rewriteCustomModels.length > 0
            ? `
                <select id="tt-novel-rw-custom-select" class="text_pole">
                    <option value="">-- 从已拉取列表速选重塑模型（${rewriteCustomModels.length}个）--</option>
                    ${rewriteCustomModels.map(m => `<option value="${escapeHtml(m)}" ${m === savedRewriteCustomModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
                </select>
            `
            : '';
        rewriteModelConfigHtml = `
            <div class="tt-novel-custom-api-box">
                <div class="tt-novel-edit-grid">
                    <label>独立重塑 Base URL（留空则自动复用「设置」里的自定义 API 地址）：
                        <input type="text" id="tt-novel-rw-custom-url" class="text_pole" placeholder="${escapeHtml(settings.bgCustomApiUrl || 'https://api.example.com/v1')}" value="${escapeHtml(settings.rewriteCustomApiUrl || '')}" />
                    </label>
                    <label>独立重塑 API Key（留空则自动复用「设置」里的 Key）：
                        <div class="tt-novel-bridge-row">
                            <input type="password" id="tt-novel-rw-custom-key" class="text_pole" placeholder="sk-...（可留空继承）" value="${escapeHtml(settings.rewriteCustomApiKey || '')}" />
                            <button type="button" id="tt-novel-rw-toggle-key" class="menu_button tt-novel-btn-sm" title="显示/隐藏 Key">👁️</button>
                        </div>
                    </label>
                    <label>重塑模型名称（可点右侧拉取或直接手填）：
                        <div class="tt-novel-bridge-row">
                            <input type="text" id="tt-novel-rw-custom-model" class="text_pole" placeholder="例如 gemini-4-argon / claude-sonnet-4" value="${escapeHtml(savedRewriteCustomModel)}" />
                            <button type="button" id="tt-novel-rw-fetch-models" class="menu_button tt-novel-btn-sm">🔄 拉取模型</button>
                        </div>
                    </label>
                    ${customSelectHtml}
                </div>
            </div>
        `;
    }

    const latestRewriteHtml = lastRewrite
        ? `
            <details class="tt-novel-round-card" open>
                <summary class="tt-novel-round-head">
                    <span><strong>🩺 第 ${lastRewrite.chapterIndex || '?'} 章深度诊断与台词排雷报告</strong> <span class="tt-novel-muted">(${escapeHtml(lastRewrite.modelLabel || '')})</span></span>
                    <span class="tt-novel-chip is-ok">${lastRewrite.beforeChars || 0}→${lastRewrite.afterChars || 0}字 · 八股 ${lastRewrite.beforeCliches ?? 0}→${lastRewrite.afterCliches ?? 0}</span>
                </summary>
                <div class="tt-novel-round-body">
                    ${lastRewrite.driftSummary ? `
                        <div class="tt-novel-diff-box" style="border-left-color: #4ac4b7;">
                            <div class="tt-novel-mini-label">📊 初稿 0-API 客观文风骨相体检</div>
                            <div class="tt-novel-pre-wrap">${escapeHtml(lastRewrite.driftSummary)}</div>
                        </div>
                    ` : ''}
                    <div class="tt-novel-diff-box">
                        <div class="tt-novel-mini-label">🔍 5 项病灶诊断、原台词排雷与执行蓝图（仅展示于此，绝不污染聊天楼层；初稿保留在上一页 Swipe）</div>
                        <div class="tt-novel-pre-wrap">${escapeHtml(lastRewrite.diagnosisPre || '（本次重写模型未单独输出 <pre> 诊断段落，已直接写入纯净正文）')}</div>
                    </div>
                </div>
            </details>
        `
        : '';

    let summaryHtml = '<div class="tt-novel-empty">当前尚未生成 AI 续写章节。续写完成后，插件会在本地 0 API 自动扫描高频八股词；若开启上方自动重塑，会在校验非空回、非道歉后自动调用指定模型推翻重塑。</div>';
    if (status.hasContinuedFloor && report) {
        if (report.totalHits === 0) {
            summaryHtml = `<div class="tt-novel-banner is-ok">✅ 最新续写章节（第 ${status.chapterIndex} 章 / 楼层 #${status.floorIndex}）八股体检通过：未检出任何高频网文八股！</div>`;
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
        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">⚡ 一键深度诊断 · 推翻重塑配置（支持双模型接力 + 空回/道歉自动拦截）</div>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-rw-auto-toggle" ${settings.autoDeepRewrite ? 'checked' : ''} />
                <span><b>开启「续写完成后自动深度诊断 · 推翻重塑本章」</b></span>
            </label>
            <div class="tt-novel-muted">
                开启后流程：主模型写完初稿 → <b>0-API 自动验空回/验道歉</b>（空回或道歉立刻拦截，绝不白扣重写费用）→ 校验通过后自动用下方指定模型跑 5 项 <code>&lt;pre&gt;</code> 诊断并推翻重写，初稿自动保留为上一页 Swipe 方便左右滑动对比。
            </div>
            <div class="tt-novel-inline-field">
                <span>重塑专用模型来源：</span>
                <select id="tt-novel-rw-mode" class="text_pole" style="max-width: 260px;">
                    <option value="bg" ${rewriteMode === 'bg' ? 'selected' : ''}>跟随后台任务 API 设置</option>
                    <option value="tavern_override" ${rewriteMode === 'tavern_override' ? 'selected' : ''}>复用酒馆当前连接 · 仅换模型名（推荐双模型）</option>
                    <option value="custom" ${rewriteMode === 'custom' ? 'selected' : ''}>独立自定义 API / 模型</option>
                </select>
            </div>
            ${rewriteModelConfigHtml}
            <div class="tt-novel-muted">当前生效重塑通道：<code>${escapeHtml(meta.rewriteModelLabel || meta.activeModel || '当前酒馆模型')}</code> · 预设：<code>${escapeHtml(meta.presetLabel || '当前酒馆预设')}</code></div>
        </section>

        <section class="tt-novel-section tt-novel-card">
            <div class="tt-novel-section-title">🔥 手动触发重塑或精修最新续写章</div>
            <input type="text" id="tt-novel-rw-extra" class="text_pole" placeholder="可选：本轮临时额外指定重点（如：压短凯尔希台词 / 加强信息差张力 / 拆短长段落）..." />
            <div class="tt-novel-action-bar">
                <button type="button" id="tt-novel-deep-rewrite-now" class="menu_button tt-novel-btn-primary" ${task.running || !status.hasContinuedFloor ? 'disabled' : ''}>
                    🔥 深度诊断 · 推翻重塑本章 (1次API · 保留初稿)
                </button>
                <button type="button" id="tt-novel-cliche-fix" class="menu_button" ${task.running || !status.hasContinuedFloor ? 'disabled' : ''}>
                    🧹 轻量局部去八股微调
                </button>
                <button type="button" id="tt-novel-cliche-rescan" class="menu_button">🔍 重新体检 (0 API)</button>
            </div>
        </section>

        ${progressHtml}
        ${latestRewriteHtml}

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
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 拉取中...';
        try {
            const list = await handlers.onFetchRewriteCustomModels?.();
            if (Array.isArray(list) && list.length > 0) {
                globalThis.toastr?.success?.(`已拉取到 ${list.length} 个重塑模型！`, '小说续写阅读器');
            } else {
                globalThis.toastr?.warning?.('接口已连上，但未返回模型列表，可直接手动填写模型名', '小说续写阅读器');
            }
        } catch (err) {
            globalThis.toastr?.error?.(`拉取重塑模型失败：${err?.message || err}`, '小说续写阅读器');
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
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

    const addChapterHtml = addingChapterOpen
        ? `
        <div class="tt-novel-card is-editing" style="margin-bottom: 10px;">
            <div class="tt-novel-section-title">➕ 手动新增原著章节</div>
            <div class="tt-novel-edit-grid">
                <div class="tt-novel-row-2">
                    <input type="text" id="tt-novel-newch-title" class="text_pole" placeholder="章节标题（例如：第 78 章 新的开始）" />
                    <select id="tt-novel-newch-role" class="text_pole">
                        <option value="main">▶️ 当前续写主线</option>
                        <option value="reference">🧭 基准时间线（已完结对照视角）</option>
                        <option value="flashback">⏪ 倒叙 / 插叙</option>
                        <option value="skip">⏭️ 跳过 / 废稿</option>
                    </select>
                </div>
                <textarea id="tt-novel-newch-content" class="text_pole" rows="5" placeholder="粘贴或输入章节正文..."></textarea>
            </div>
            <div class="tt-novel-card-actions">
                <button type="button" id="tt-novel-newch-save" class="menu_button tt-novel-btn-sm tt-novel-btn-primary">💾 保存章节</button>
                <button type="button" id="tt-novel-newch-cancel" class="menu_button tt-novel-btn-sm">取消</button>
            </div>
        </div>
        `
        : '';

    const bulkToolsHtml = novel?.chapters?.length
        ? `
        <details class="tt-novel-fold-card" style="margin-bottom: 8px;">
            <summary>🛠️ 按章号区间批量标注 / 删除（可快速标记倒叙卷、他视角或剔除多余章节）</summary>
            <div class="tt-novel-edit-grid" style="margin-top: 8px;">
                <input type="text" id="tt-novel-toc-bulk-range" class="text_pole" value="${escapeHtml(tocBulkRangeText)}" placeholder="输入章号或区间，如：78-135 或 10, 22-25" />
                <div class="tt-novel-action-bar">
                    <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-bulk-action="mark_reference">🧭 设为基准时间线</button>
                    <button type="button" class="menu_button tt-novel-btn-sm" data-bulk-action="mark_main">▶️ 设为续写主线</button>
                    <button type="button" class="menu_button tt-novel-btn-sm" data-bulk-action="mark_flashback">⏪ 设为倒叙/插叙</button>
                    <button type="button" class="menu_button tt-novel-btn-sm" data-bulk-action="mark_skip">⏭️ 设为跳过</button>
                    <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-stop" data-bulk-action="delete">🗑️ 批量删除</button>
                </div>
            </div>
        </details>
        `
        : '';

    bodyEl.innerHTML = `
        <div class="tt-novel-toc-jumps">
            <button type="button" id="tt-novel-jump-cutoff" class="tt-novel-jump-btn">📍 跳至断更处</button>
            <button type="button" id="tt-novel-jump-latest" class="tt-novel-jump-btn">🔥 跳至最新章</button>
            <button type="button" id="tt-novel-jump-saved" class="tt-novel-jump-btn">🔖 上次阅读</button>
            <button type="button" id="tt-novel-toc-add-ch" class="tt-novel-jump-btn">➕ 新增章节</button>
        </div>
        ${addChapterHtml}
        ${bulkToolsHtml}
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
            const refCount = novel.chapters.filter(c => c.timelineRole === 'reference').length;
            const fbCount = novel.chapters.filter(c => c.timelineRole === 'flashback').length;
            const skipCount = novel.chapters.filter(c => c.timelineRole === 'skip').length;
            const extraMeta = `${refCount > 0 ? ` · ${refCount}章基准线` : ''}${fbCount > 0 ? ` · ${fbCount}章倒叙` : ''}${skipCount > 0 ? ` · ${skipCount}章跳过` : ''}`;
            rows.push(`<div class="tt-novel-toc-divider">📚 原著章节（共 ${novel.totalChapters} 章 · 当前锚点 #${cutoff}${extraMeta}）</div>`);
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
                                        <option value="main" ${ch.timelineRole !== 'reference' && ch.timelineRole !== 'flashback' && ch.timelineRole !== 'skip' ? 'selected' : ''}>▶️ 当前续写主线</option>
                                        <option value="reference" ${ch.timelineRole === 'reference' ? 'selected' : ''}>🧭 基准时间线（对照原著）</option>
                                        <option value="flashback" ${ch.timelineRole === 'flashback' ? 'selected' : ''}>⏪ 倒叙 / 插叙</option>
                                        <option value="skip" ${ch.timelineRole === 'skip' ? 'selected' : ''}>⏭️ 跳过 / 废稿</option>
                                    </select>
                                </div>
                                <textarea class="text_pole" rows="6" data-field="content">${escapeHtml(ch.content || '')}</textarea>
                            </div>
                            <div class="tt-novel-card-actions">
                                <button type="button" class="menu_button tt-novel-btn-sm tt-novel-btn-primary" data-action="save-orig-ch" data-orig-index="${ch.index}">💾 保存章节</button>
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
                const tagText = isAfter ? '屏蔽' : (isCutoff ? '夺舍点' : `#${ch.index}`);
                const roleChip = role === 'reference'
                    ? '<span class="tt-novel-chip is-ok">🧭基准</span>'
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
                            <button type="button" class="tt-novel-cutoff-btn" data-action="cutoff-here" data-orig-index="${ch.index}">夺舍</button>
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="edit-orig-ch" data-orig-index="${ch.index}" title="编辑此章">✏️</button>
                            <button type="button" class="tt-novel-mini-icon-btn" data-action="del-orig-ch" data-orig-index="${ch.index}" title="删除此章">🗑️</button>
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
                if (!window.confirm(`确定删除原著第 ${idx} 章吗？删除后后续章号将自动顺延重排。`)) return;
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
            globalThis.toastr?.warning?.('请输入章节正文', '小说续写阅读器');
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
                globalThis.toastr?.warning?.('请先输入章号区间（例如：78-135）', '小说续写阅读器');
                return;
            }
            if (action === 'delete' && !window.confirm(`确定批量删除区间 [${rangeText}] 的原著章节吗？此操作不可撤销。`)) {
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
            <label class="checkbox_label"><input type="checkbox" data-setting="autoDeepRewrite" ${settings.autoDeepRewrite ? 'checked' : ''} /><span>⚡ 续写完成后自动触发深度诊断重塑（带空回/道歉拦截，可在「🩺 精修重塑」指定独立重塑模型）</span></label>
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
