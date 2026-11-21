import { escapeHtml, debounce } from '/scripts/utils.js';
import { getContext } from '/scripts/extensions.js';
import { isBoundedChatSurfaceView, jumpBoundedChatSurfaceToMessage, resetChatSurfaceView } from '/script.js';
import { isContinuedNovelFloor } from './context-assembler.js';
import { loadLedger, loadNovelData, saveLedger } from './storage.js';

const PROGRESS_META_KEY = 'novel_continuation_progress';
const TOC_PAGE_LIMIT = 100;

let drawerOpen = false;
let showAllOriginalChapters = false;
let previewChapterIndex = null;
let cachedNovelData = null;
let cachedLedger = null;
let onCutoffCallback = null;
let onViewChapterCallback = null;
let onSettingChangeCallback = null;

/**
 * Applies or removes the body CSS classes for Immersive Novel Mode, Hide User Floors, and Hide Reasoning.
 * When master switch `settings.enabled` is false, all classes and the quickbar are cleanly withdrawn.
 *
 * @param {{ enabled?: boolean, immersiveMode?: boolean, hideUserFloors?: boolean, hideReasoning?: boolean }} settings
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
    if (!active && drawerOpen) {
        toggleTocDrawer(false);
    }
    syncQuickBarState(settings);
}

/**
 * Mounts the above-input quick bar and right-edge floating TOC drawer.
 */
export function mountReaderUi({
    settings,
    onToggleSetting,
    onCutoffFromChapter,
    onViewChapter,
}) {
    onCutoffCallback = onCutoffFromChapter;
    onViewChapterCallback = onViewChapter;
    onSettingChangeCallback = onToggleSetting;

    mountQuickBar(settings);
    mountFloatingTocDrawer();
    installScrollProgressTracker();
    applyReaderBodyClasses(settings);
}

function mountQuickBar(settings) {
    if (document.getElementById('tt-novel-quickbar')) return;
    const sendForm = document.getElementById('send_form') || document.getElementById('form_sheld');
    if (!sendForm) return;

    const bar = document.createElement('div');
    bar.id = 'tt-novel-quickbar';
    bar.className = 'tt-novel-quickbar';
    bar.innerHTML = `
        <div class="tt-novel-quickbar-left">
            <button type="button" id="tt-novel-btn-immersive" class="tt-novel-pill" title="切换起点/微信读书式无头像连续书页排版">
                <i class="fa-solid fa-book-open"></i> <span>沉浸小说</span>
            </button>
            <button type="button" id="tt-novel-btn-hide-user" class="tt-novel-pill" title="隐藏所有用户指令楼层，让原著与续写正文无缝相连">
                <i class="fa-solid fa-eye-slash"></i> <span>隐藏指令</span>
            </button>
            <button type="button" id="tt-novel-btn-hide-cot" class="tt-novel-pill" title="隐藏 AI 思考批注与预设思维链折叠框">
                <i class="fa-solid fa-brain"></i> <span>隐藏思维链</span>
            </button>
            <button type="button" id="tt-novel-btn-author-mode" class="tt-novel-pill" title="开启作者境界：屏蔽酒馆玩家 {{user}} 人设与 RP 规则，将输入自动转为导演大纲">
                <i class="fa-solid fa-feather-pointed"></i> <span>作者境界</span>
            </button>
            <button type="button" id="tt-novel-btn-prev-ch" class="tt-novel-pill" title="观看上一章">
                <i class="fa-solid fa-chevron-left"></i> <span>上一章</span>
            </button>
            <button type="button" id="tt-novel-btn-next-ch" class="tt-novel-pill" title="观看下一章">
                <span>下一章</span> <i class="fa-solid fa-chevron-right"></i>
            </button>
            <button type="button" id="tt-novel-btn-toc" class="tt-novel-pill tt-novel-pill-accent" title="打开章节目录、进度跳转与截断重续抽屉">
                <i class="fa-solid fa-list-ul"></i> <span id="tt-novel-toc-badge">章节目录</span>
            </button>
        </div>
        <div class="tt-novel-quickbar-hooks" id="tt-novel-quickbar-hooks"></div>
    `;

    sendForm.parentElement?.insertBefore(bar, sendForm);

    bar.querySelector('#tt-novel-btn-immersive')?.addEventListener('click', () => {
        onSettingChangeCallback?.('immersiveMode');
    });
    bar.querySelector('#tt-novel-btn-hide-user')?.addEventListener('click', () => {
        onSettingChangeCallback?.('hideUserFloors');
    });
    bar.querySelector('#tt-novel-btn-hide-cot')?.addEventListener('click', () => {
        onSettingChangeCallback?.('hideReasoning');
    });
    bar.querySelector('#tt-novel-btn-author-mode')?.addEventListener('click', () => {
        onSettingChangeCallback?.('authorMode');
    });
    bar.querySelector('#tt-novel-btn-prev-ch')?.addEventListener('click', async () => {
        if (!cachedNovelData?.totalChapters) return;
        const curr = getCurrentVisibleOriginalChapterIndex()
            || Number(cachedNovelData.viewingChapterIndex || cachedNovelData.cutoffChapterIndex || 1);
        const target = Math.max(1, curr - 1);
        await onViewChapterCallback?.(target);
    });
    bar.querySelector('#tt-novel-btn-next-ch')?.addEventListener('click', async () => {
        if (!cachedNovelData?.totalChapters) return;
        const curr = getCurrentVisibleOriginalChapterIndex()
            || Number(cachedNovelData.viewingChapterIndex || cachedNovelData.cutoffChapterIndex || 1);
        const target = Math.min(cachedNovelData.totalChapters, curr + 1);
        await onViewChapterCallback?.(target);
    });
    bar.querySelector('#tt-novel-btn-toc')?.addEventListener('click', () => {
        toggleTocDrawer();
    });

    syncQuickBarState(settings);
}

export function syncQuickBarState(settings) {
    const btnImmersive = document.getElementById('tt-novel-btn-immersive');
    const btnHideUser = document.getElementById('tt-novel-btn-hide-user');
    const btnHideCot = document.getElementById('tt-novel-btn-hide-cot');
    const btnAuthorMode = document.getElementById('tt-novel-btn-author-mode');
    if (btnImmersive) {
        btnImmersive.classList.toggle('active', Boolean(settings?.immersiveMode));
    }
    if (btnHideUser) {
        btnHideUser.classList.toggle('active', Boolean(settings?.hideUserFloors));
    }
    if (btnHideCot) {
        btnHideCot.classList.toggle('active', settings?.hideReasoning !== false);
    }
    if (btnAuthorMode) {
        btnAuthorMode.classList.toggle('active', settings?.authorMode !== false);
    }
}

/**
 * Refreshes the Foreshadowing Hook pills in the quickbar and the TOC drawer data.
 */
export async function refreshReaderWidgets() {
    const [novelData, ledger] = await Promise.all([loadNovelData(), loadLedger()]);
    cachedNovelData = novelData;
    cachedLedger = ledger;

    const badge = document.getElementById('tt-novel-toc-badge');
    if (badge) {
        if (novelData?.totalChapters) {
            badge.textContent = `目录 (${novelData.cutoffChapterIndex}/${novelData.totalChapters}章)`;
        } else {
            badge.textContent = '章节目录';
        }
    }

    renderQuickBarHooks(ledger);
    if (drawerOpen) {
        renderTocDrawerBody();
    }
}

function renderQuickBarHooks(ledger) {
    const container = document.getElementById('tt-novel-quickbar-hooks');
    if (!container) return;

    const openHooks = (ledger?.hooks || []).filter(h => h.status !== 'resolved');
    const htmlParts = openHooks.slice(-6).map(hook => {
        const isPinned = hook.status === 'pinned';
        const label = hook.content.length > 18 ? `${hook.content.slice(0, 18)}…` : hook.content;
        return `
            <button type="button"
                class="tt-novel-hook-chip ${isPinned ? 'pinned' : ''}"
                data-hook-id="${escapeHtml(hook.id)}"
                title="${escapeHtml(hook.content)}\n（点击切换：${isPinned ? '已设为本章重点推进' : '普通暗线，点击指派到本章推进'}）">
                ${isPinned ? '🎯' : '🔮'} ${escapeHtml(label)}
            </button>
        `;
    });

    htmlParts.push(`
        <button type="button" id="tt-novel-add-hook-btn" class="tt-novel-hook-add" title="手动添加一条伏笔或本章剧情线索">
            + 伏笔
        </button>
    `);

    container.innerHTML = htmlParts.join('');

    container.querySelectorAll('.tt-novel-hook-chip').forEach(btn => {
        btn.addEventListener('click', async () => {
            const hookId = btn.getAttribute('data-hook-id');
            const currentLedger = await loadLedger();
            const target = currentLedger.hooks.find(h => h.id === hookId);
            if (target) {
                target.status = target.status === 'pinned' ? 'open' : 'pinned';
                await saveLedger(currentLedger);
                await refreshReaderWidgets();
            }
        });
    });

    container.querySelector('#tt-novel-add-hook-btn')?.addEventListener('click', async () => {
        const input = window.prompt('请输入要埋下或本章要推进的伏笔线索：');
        if (!input || !input.trim()) return;
        const currentLedger = await loadLedger();
        currentLedger.hooks.push({
            id: `hook_${Date.now()}`,
            content: input.trim(),
            plantedChapter: Number(cachedNovelData?.cutoffChapterIndex || 1),
            status: 'pinned',
        });
        await saveLedger(currentLedger);
        await refreshReaderWidgets();
    });
}

function mountFloatingTocDrawer() {
    if (document.getElementById('tt-novel-toc-drawer')) return;

    const drawer = document.createElement('aside');
    drawer.id = 'tt-novel-toc-drawer';
    drawer.className = 'tt-novel-toc-drawer';
    drawer.innerHTML = `
        <div class="tt-novel-toc-header">
            <div class="tt-novel-toc-title-row">
                <h4 id="tt-novel-toc-book-title">📑 章节目录与进度</h4>
                <button type="button" id="tt-novel-toc-close" class="tt-novel-icon-btn" title="关闭目录">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="tt-novel-toc-jumps">
                <button type="button" id="tt-novel-jump-cutoff" class="tt-novel-jump-btn" title="定位到原著断更末章与 AI 续写第一章的交界处">
                    📍 跳至断更处
                </button>
                <button type="button" id="tt-novel-jump-latest" class="tt-novel-jump-btn" title="跳转到最新的续写章节底部">
                    🔥 跳至最新章
                </button>
                <button type="button" id="tt-novel-jump-saved" class="tt-novel-jump-btn" title="回到上次自动记录的阅读楼层">
                    🔖 上次阅读
                </button>
            </div>
            <div class="tt-novel-toc-search-row">
                <input type="search" id="tt-novel-toc-search" class="text_pole" placeholder="搜索章节标题或原著关键词..." />
            </div>
        </div>
        <div id="tt-novel-toc-preview" class="tt-novel-toc-preview displayNone"></div>
        <div id="tt-novel-toc-list" class="tt-novel-toc-list"></div>
    `;

    document.body.appendChild(drawer);

    drawer.querySelector('#tt-novel-toc-close')?.addEventListener('click', () => toggleTocDrawer(false));
    drawer.querySelector('#tt-novel-jump-cutoff')?.addEventListener('click', async () => {
        await toggleTocDrawer(false);
        if (cachedNovelData && onViewChapterCallback) {
            await onViewChapterCallback(cachedNovelData.cutoffChapterIndex || cachedNovelData.totalChapters);
        } else {
            await jumpToCutoffBoundary();
        }
    });
    drawer.querySelector('#tt-novel-jump-latest')?.addEventListener('click', async () => {
        await toggleTocDrawer(false);
        await jumpToLatestFloor();
    });
    drawer.querySelector('#tt-novel-jump-saved')?.addEventListener('click', async () => {
        await toggleTocDrawer(false);
        await jumpToSavedProgress();
    });
    drawer.querySelector('#tt-novel-toc-search')?.addEventListener(
        'input',
        debounce(() => renderTocDrawerBody(), 250),
    );
}

export async function toggleTocDrawer(forceState) {
    drawerOpen = typeof forceState === 'boolean' ? forceState : !drawerOpen;
    const drawer = document.getElementById('tt-novel-toc-drawer');
    if (!drawer) return;
    drawer.classList.toggle('open', drawerOpen);
    if (drawerOpen) {
        await refreshReaderWidgets();
    }
}

function renderTocDrawerBody() {
    const listEl = document.getElementById('tt-novel-toc-list');
    const titleEl = document.getElementById('tt-novel-toc-book-title');
    const searchEl = /** @type {HTMLInputElement | null} */ (document.getElementById('tt-novel-toc-search'));
    if (!listEl) return;

    const filterText = String(searchEl?.value || '').trim().toLowerCase();
    const chat = getContext()?.chat || [];
    const novel = cachedNovelData;

    if (titleEl) {
        titleEl.textContent = novel?.title
            ? `📑 《${novel.title}》 (${novel.cutoffChapterIndex}/${novel.totalChapters}章)`
            : '📑 章节目录与进度';
    }

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
        const swipeCount = Array.isArray(msg.swipes) ? msg.swipes.length : 1;
        aiFloors.push({
            floorIdx,
            title: cleanHeading,
            swipeCount,
            wordCount: String(msg.mes || '').replace(/\s+/g, '').length,
        });
    });

    const rows = [];

    if (novel?.chapters?.length) {
        const cutoff = novel.cutoffChapterIndex || novel.totalChapters;
        rows.push(`<div class="tt-novel-toc-divider">📚 原著章节（共 ${novel.totalChapters} 章 · 已导入第 1~${cutoff} 章，酒馆自动隐藏高楼层）</div>`);

        let visibleChapters = novel.chapters;
        if (filterText) {
            // Fast title match first; only scan body if < 30 matches and query >= 2 chars
            const titleHits = novel.chapters.filter(ch => ch.title.toLowerCase().includes(filterText));
            if (titleHits.length >= 20 || filterText.length < 2) {
                visibleChapters = titleHits;
            } else {
                const bodyHits = [];
                for (const ch of novel.chapters) {
                    if (ch.title.toLowerCase().includes(filterText) || ch.content.toLowerCase().includes(filterText)) {
                        bodyHits.push(ch);
                        if (bodyHits.length >= 80) break;
                    }
                }
                visibleChapters = bodyHits;
            }
        } else if (!showAllOriginalChapters && novel.chapters.length > TOC_PAGE_LIMIT) {
            const half = Math.floor(TOC_PAGE_LIMIT / 2);
            const start = Math.max(0, Math.min(novel.chapters.length - TOC_PAGE_LIMIT, cutoff - half));
            visibleChapters = novel.chapters.slice(start, start + TOC_PAGE_LIMIT);
            rows.push(`
                <button type="button" id="tt-novel-toc-show-all" class="tt-novel-jump-btn">
                    展开全部 ${novel.chapters.length} 章（当前展示第 ${visibleChapters[0].index}~${visibleChapters[visibleChapters.length - 1].index} 章）
                </button>
            `);
        }

        for (const ch of visibleChapters) {
            const mountedFloor = originalFloorByChapter.get(ch.index);
            const isMounted = mountedFloor !== undefined;
            const isCutoff = ch.index === cutoff;
            const isAfterCutoff = ch.index > cutoff;
            const tagClass = isAfterCutoff ? 'masked' : (isCutoff ? 'cutoff' : 'orig');
            const tagText = isAfterCutoff ? '已屏蔽' : (isCutoff ? '夺舍点' : '原著');
            rows.push(`
                <div class="tt-novel-toc-item ${isCutoff ? 'is-cutoff' : ''} ${isAfterCutoff ? 'is-masked' : ''}" data-orig-index="${ch.index}">
                    <div class="tt-novel-toc-item-main" data-action="view-orig" data-orig-index="${ch.index}" title="点击直接在主屏幕阅读第 ${ch.index} 章">
                        <span class="tt-novel-toc-tag ${tagClass}">${tagText}</span>
                        <span class="tt-novel-toc-name">${escapeHtml(ch.title)}</span>
                        <span class="tt-novel-toc-meta">${isMounted ? `#${mountedFloor}` : `${ch.wordCount}字`}</span>
                    </div>
                    <div class="tt-novel-toc-actions">
                        <button type="button" class="tt-novel-view-btn" data-action="view-orig" data-orig-index="${ch.index}" title="在主阅读界面观看第 ${ch.index} 章">
                            👁️ 阅读本章
                        </button>
                        <button type="button" class="tt-novel-cutoff-btn" data-action="cutoff-here" data-orig-index="${ch.index}" title="从此章夺舍重续：导入第 1~${ch.index} 章，并自动屏蔽第 ${ch.index + 1} 章及之后的原著剧情">
                            ✂️ 从此夺舍
                        </button>
                    </div>
                </div>
            `);
        }
    }

    rows.push(`<div class="tt-novel-toc-divider">✦ AI 续写章节（${aiFloors.length} 章）</div>`);
    if (aiFloors.length === 0) {
        rows.push('<div class="tt-novel-toc-empty">暂无续写章节，在底部输入框发送指令即可单次调用生成下一章。</div>');
    } else {
        aiFloors.forEach((item, idx) => {
            if (filterText && !item.title.toLowerCase().includes(filterText)) return;
            rows.push(`
                <div class="tt-novel-toc-item is-ai" data-action="jump-floor" data-floor="${item.floorIdx}">
                    <div class="tt-novel-toc-item-main">
                        <span class="tt-novel-toc-tag ai">续写 ${idx + 1}</span>
                        <span class="tt-novel-toc-name">${escapeHtml(item.title)}</span>
                        <span class="tt-novel-toc-meta">${item.swipeCount > 1 ? `[${item.swipeCount}分支] ` : ''}${item.wordCount}字 · #${item.floorIdx}</span>
                    </div>
                </div>
            `);
        });
    }

    listEl.innerHTML = rows.join('');

    listEl.querySelector('#tt-novel-toc-show-all')?.addEventListener('click', () => {
        showAllOriginalChapters = true;
        renderTocDrawerBody();
    });

    listEl.querySelectorAll('[data-action="jump-floor"]').forEach(el => {
        el.addEventListener('click', async () => {
            const floor = Number(el.getAttribute('data-floor'));
            await toggleTocDrawer(false);
            await scrollToChatFloor(floor);
        });
    });

    listEl.querySelectorAll('[data-action="view-orig"]').forEach(el => {
        el.addEventListener('click', async () => {
            const idx = Number(el.getAttribute('data-orig-index'));
            await toggleTocDrawer(false);
            const mountedFloor = originalFloorByChapter.get(idx);
            if (mountedFloor !== undefined) {
                if (cachedNovelData) {
                    cachedNovelData.viewingChapterIndex = idx;
                }
                await scrollToChatFloor(mountedFloor);
            } else if (onViewChapterCallback) {
                await onViewChapterCallback(idx);
            } else {
                openOriginalChapterPreview(idx);
            }
        });
    });

    listEl.querySelectorAll('[data-action="cutoff-here"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const idx = Number(btn.getAttribute('data-orig-index'));
            await toggleTocDrawer(false);
            if (onCutoffCallback) {
                await onCutoffCallback(idx);
                await refreshReaderWidgets();
            }
        });
    });
}

function openOriginalChapterPreview(chapterIndex) {
    const previewEl = document.getElementById('tt-novel-toc-preview');
    if (!previewEl || !cachedNovelData) return;
    const ch = cachedNovelData.chapters.find(c => c.index === chapterIndex);
    if (!ch) return;
    previewChapterIndex = chapterIndex;

    previewEl.classList.remove('displayNone');
    previewEl.innerHTML = `
        <div class="tt-novel-preview-header">
            <strong>${escapeHtml(ch.title)}（${ch.wordCount}字）</strong>
            <div>
                <button type="button" id="tt-novel-preview-cutoff" class="tt-novel-cutoff-btn">✂️ 从此章截断重续</button>
                <button type="button" id="tt-novel-preview-close" class="tt-novel-icon-btn"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
        <div class="tt-novel-preview-body">${escapeHtml(ch.content).replace(/\n+/g, '<br><br>')}</div>
    `;

    previewEl.querySelector('#tt-novel-preview-close')?.addEventListener('click', () => {
        previewEl.classList.add('displayNone');
    });
    previewEl.querySelector('#tt-novel-preview-cutoff')?.addEventListener('click', async () => {
        if (onCutoffCallback && previewChapterIndex) {
            await onCutoffCallback(previewChapterIndex);
            previewEl.classList.add('displayNone');
            await refreshReaderWidgets();
        }
    });
}

/**
 * Returns the original chapter index currently visible near the top of `#chat`, or null if none.
 * @returns {number | null}
 */
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

/**
 * Scrolls `#chat` to the specified message floor index, using TauriTavern's native
 * `jumpBoundedChatSurfaceToMessage` when BoundedChatSurface virtualization is active,
 * and self-healing if classic mode missed mounting newly added floors.
 * @param {number} floorIndex
 */
export async function scrollToChatFloor(floorIndex) {
    const chatEl = document.getElementById('chat');
    if (!chatEl || !Number.isFinite(floorIndex) || floorIndex < 0) return;

    // Wait 2 animation frames so TauriTavern's printMessages() requestAnimationFrame scrollChatToBottom finishes first
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

    // Self-heal if floor exists in context.chat but wasn't mounted in DOM (e.g. stale mountedIds cache)
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
    // Re-assert after TauriTavern's 200ms scrollOnMediaLoad delay
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
    if (lastOrigFloor >= 0) {
        await scrollToChatFloor(lastOrigFloor);
    } else if (chat.length > 0) {
        await scrollToChatFloor(0);
    }
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
