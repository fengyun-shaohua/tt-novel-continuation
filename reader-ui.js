import { escapeHtml, debounce } from '/scripts/utils.js';
import { getContext } from '/scripts/extensions.js';
import { loadLedger, loadNovelData, saveLedger } from './storage.js';

const PROGRESS_META_KEY = 'novel_continuation_progress';

let drawerOpen = false;
let previewChapterIndex = null;
let cachedNovelData = null;
let cachedLedger = null;
let onCutoffCallback = null;
let onSettingChangeCallback = null;

/**
 * Applies or removes the body CSS classes for Immersive Novel Mode and Hide User Floors.
 * @param {{ immersiveMode?: boolean, hideUserFloors?: boolean }} settings
 */
export function applyReaderBodyClasses(settings) {
    document.body.classList.toggle('tt-novel-immersive', Boolean(settings?.immersiveMode));
    document.body.classList.toggle('tt-novel-hide-user-floors', Boolean(settings?.hideUserFloors));
    syncQuickBarState(settings);
}

/**
 * Mounts the above-input quick bar and right-edge floating TOC drawer.
 */
export function mountReaderUi({ settings, onToggleSetting, onCutoffFromChapter }) {
    onCutoffCallback = onCutoffFromChapter;
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
    bar.querySelector('#tt-novel-btn-toc')?.addEventListener('click', () => {
        toggleTocDrawer();
    });

    syncQuickBarState(settings);
}

export function syncQuickBarState(settings) {
    const btnImmersive = document.getElementById('tt-novel-btn-immersive');
    const btnHideUser = document.getElementById('tt-novel-btn-hide-user');
    if (btnImmersive) {
        btnImmersive.classList.toggle('active', Boolean(settings?.immersiveMode));
    }
    if (btnHideUser) {
        btnHideUser.classList.toggle('active', Boolean(settings?.hideUserFloors));
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
    drawer.querySelector('#tt-novel-jump-cutoff')?.addEventListener('click', () => jumpToCutoffBoundary());
    drawer.querySelector('#tt-novel-jump-latest')?.addEventListener('click', () => jumpToLatestFloor());
    drawer.querySelector('#tt-novel-jump-saved')?.addEventListener('click', () => jumpToSavedProgress());
    drawer.querySelector('#tt-novel-toc-search')?.addEventListener('input', () => renderTocDrawerBody());
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

    // Map chat floors to original chapter index or AI continuation floors
    const originalFloorByChapter = new Map();
    const aiFloors = [];
    chat.forEach((msg, floorIdx) => {
        if (!msg || msg.is_user || msg.is_system) return;
        const origIdx = Number(msg.extra?.novelChapterIndex);
        if (msg.extra?.novelContinuationOrigin === 'original' && origIdx > 0) {
            originalFloorByChapter.set(origIdx, floorIdx);
        } else {
            const firstLine = String(msg.mes || '').split('\n').map(l => l.trim()).find(Boolean) || `续写章节`;
            const cleanHeading = firstLine.replace(/^#+\s*/, '').slice(0, 38);
            const swipeCount = Array.isArray(msg.swipes) ? msg.swipes.length : 1;
            aiFloors.push({
                floorIdx,
                title: cleanHeading,
                swipeCount,
                wordCount: String(msg.mes || '').replace(/\s+/g, '').length,
            });
        }
    });

    const rows = [];

    if (novel?.chapters?.length) {
        const cutoff = novel.cutoffChapterIndex || novel.totalChapters;
        rows.push(`<div class="tt-novel-toc-divider">📚 原著章节（共 ${novel.totalChapters} 章，当前接续自第 ${cutoff} 章）</div>`);

        for (const ch of novel.chapters) {
            if (filterText && !ch.title.toLowerCase().includes(filterText) && !ch.content.toLowerCase().includes(filterText)) {
                continue;
            }
            const mountedFloor = originalFloorByChapter.get(ch.index);
            const isCutoff = ch.index === cutoff;
            const isAfterCutoff = ch.index > cutoff;
            rows.push(`
                <div class="tt-novel-toc-item ${isCutoff ? 'is-cutoff' : ''} ${isAfterCutoff ? 'is-masked' : ''}" data-orig-index="${ch.index}">
                    <div class="tt-novel-toc-item-main" data-action="view-orig" data-orig-index="${ch.index}">
                        <span class="tt-novel-toc-tag ${isAfterCutoff ? 'masked' : 'orig'}">${isAfterCutoff ? '已屏蔽' : (isCutoff ? '断更点' : '原著')}</span>
                        <span class="tt-novel-toc-name">${escapeHtml(ch.title)}</span>
                        <span class="tt-novel-toc-meta">${mountedFloor !== undefined ? `#${mountedFloor}` : `${ch.wordCount}字`}</span>
                    </div>
                    <button type="button" class="tt-novel-cutoff-btn" data-action="cutoff-here" data-orig-index="${ch.index}" title="从此章截断重续：将第 ${ch.index} 章设为新的终点并铺入聊天，自动屏蔽第 ${ch.index + 1} 章及之后的原著剧情">
                        ✂️ 从此重续
                    </button>
                </div>
            `);
        }
    }

    rows.push(`<div class="tt-novel-toc-divider">✦ AI 续写与当前聊天章节（${aiFloors.length} 章）</div>`);
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

    listEl.querySelectorAll('[data-action="jump-floor"]').forEach(el => {
        el.addEventListener('click', () => {
            const floor = Number(el.getAttribute('data-floor'));
            scrollToChatFloor(floor);
        });
    });

    listEl.querySelectorAll('[data-action="view-orig"]').forEach(el => {
        el.addEventListener('click', () => {
            const idx = Number(el.getAttribute('data-orig-index'));
            const mountedFloor = originalFloorByChapter.get(idx);
            if (mountedFloor !== undefined) {
                scrollToChatFloor(mountedFloor);
            } else {
                openOriginalChapterPreview(idx);
            }
        });
    });

    listEl.querySelectorAll('[data-action="cutoff-here"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const idx = Number(btn.getAttribute('data-orig-index'));
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
 * Scrolls `#chat` to the specified message floor index, automatically clicking
 * `#show_more_messages` if the target floor is above the currently mounted DOM window.
 * @param {number} floorIndex
 */
export function scrollToChatFloor(floorIndex) {
    const chatEl = document.getElementById('chat');
    if (!chatEl || !Number.isFinite(floorIndex) || floorIndex < 0) return;

    let guard = 0;
    while (!chatEl.querySelector(`.mes[mesid="${floorIndex}"]`) && guard < 25) {
        const showMoreBtn = document.getElementById('show_more_messages');
        if (!showMoreBtn) break;
        showMoreBtn.click();
        guard += 1;
    }

    const targetMes = chatEl.querySelector(`.mes[mesid="${floorIndex}"]`);
    if (targetMes) {
        targetMes.scrollIntoView({ behavior: 'smooth', block: 'start' });
        targetMes.classList.add('tt-novel-flash-highlight');
        setTimeout(() => targetMes.classList.remove('tt-novel-flash-highlight'), 1600);
        saveReadingProgress(floorIndex);
    }
}

function jumpToCutoffBoundary() {
    const chat = getContext()?.chat || [];
    let lastOrigFloor = -1;
    chat.forEach((msg, idx) => {
        if (msg?.extra?.novelContinuationOrigin === 'original') {
            lastOrigFloor = idx;
        }
    });
    if (lastOrigFloor >= 0) {
        scrollToChatFloor(lastOrigFloor);
    } else if (chat.length > 0) {
        scrollToChatFloor(0);
    }
}

function jumpToLatestFloor() {
    const chat = getContext()?.chat || [];
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (!chat[i]?.is_user) {
            scrollToChatFloor(i);
            return;
        }
    }
}

function jumpToSavedProgress() {
    const progress = getContext()?.chatMetadata?.[PROGRESS_META_KEY];
    if (progress && Number.isFinite(progress.floorIndex)) {
        scrollToChatFloor(progress.floorIndex);
    } else {
        jumpToCutoffBoundary();
    }
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

    const onScroll = debounce(() => {
        const rect = chatEl.getBoundingClientRect();
        const midY = rect.top + rect.height * 0.35;
        const blocks = chatEl.querySelectorAll('.mes:not([is_user="true"])');
        for (const block of blocks) {
            const bRect = block.getBoundingClientRect();
            if (bRect.top <= midY && bRect.bottom >= rect.top) {
                const mesId = Number(block.getAttribute('mesid'));
                if (Number.isFinite(mesId)) {
                    saveReadingProgress(mesId);
                }
                break;
            }
        }
    }, 900);

    chatEl.addEventListener('scroll', onScroll, { passive: true });
}
