import { extension_settings, getContext } from '/scripts/extensions.js';
import { extension_prompt_roles, extension_prompt_types } from '/scripts/extension-prompts.js';
import { escapeHtml } from '/scripts/utils.js';
import { buildSingleCallContinuationContext, resolveCurrentTargetChapterIndex } from './context-assembler.js';
import { extractNovelStateBlock, parseNovelTxt, parseSupplementaryDatabase } from './parser.js';
import {
    applyReaderBodyClasses,
    clearReadingProgress,
    mountReaderUi,
    refreshReaderWidgets,
    scrollToChatFloor,
    toggleTocDrawer,
} from './reader-ui.js';
import { connectRemoteBridge, disconnectRemoteBridge } from './remote-bridge.js';
import {
    applyExtractedStateToLedger,
    clearNovelData,
    createEmptyCanonDb,
    createEmptyLedger,
    loadCanonDb,
    loadLedger,
    loadNovelData,
    pruneLedgerAfterChapter,
    saveCanonDb,
    saveLedger,
    saveNovelData,
    syncWorldUpdatesToTavernLorebook,
} from './storage.js';

const SETTINGS_KEY = 'novel_continuation';
const EXTENSION_PROMPT_TAG = 'novel_continuation_golden_context';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    immersiveMode: true,
    hideUserFloors: true,
    hideReasoning: true,
    enableAutoStateBlock: true,
    syncToWorldInfo: true,
    mountAnchorChapters: 3,
    maxOriginalHits: 3,
    maxCanonHits: 4,
    maxRecentSummaries: 6,
    remoteBridgeUrl: '',
});

function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[SETTINGS_KEY][k] === undefined) {
            extension_settings[SETTINGS_KEY][k] = v;
        }
    }
    return extension_settings[SETTINGS_KEY];
}

function saveExtensionSettings() {
    getContext()?.saveSettingsDebounced?.();
}

/**
 * Global generation interceptor registered in `manifest.json`.
 * Assembles the Pagekin-style Single-Call Golden Context in local memory (<5ms, 0 extra API calls).
 */
globalThis.novelContinuation_interceptGeneration = async function (chat, _contextSize, _abort, type) {
    const settings = getSettings();
    const context = getContext();
    if (!settings.enabled || type === 'quiet' || type === 'impersonate') {
        context?.setExtensionPrompt?.(EXTENSION_PROMPT_TAG, '', extension_prompt_types.NONE, 0);
        return;
    }

    try {
        const [novelData, ledger, canonDb] = await Promise.all([loadNovelData(), loadLedger(), loadCanonDb()]);
        const promptBlock = buildSingleCallContinuationContext({
            chat,
            novelData,
            ledger,
            canonDb,
            settings,
            generationType: type || 'normal',
        });

        if (promptBlock) {
            context?.setExtensionPrompt?.(
                EXTENSION_PROMPT_TAG,
                promptBlock,
                extension_prompt_types.IN_CHAT,
                1,
                false,
                extension_prompt_roles.SYSTEM,
            );
        } else {
            context?.setExtensionPrompt?.(EXTENSION_PROMPT_TAG, '', extension_prompt_types.NONE, 0);
        }
    } catch (error) {
        console.warn('[小说续写阅读器] 组装单次上下文时出错：', error);
    }
};

/**
 * Strips `<novel_state>...</novel_state>` after a single-call chapter generation completes,
 * keeping the visible novel text pure and updating the local timeline ledger + World Info.
 */
async function onMessageReceived(messageId, type) {
    const settings = getSettings();
    if (!settings.enabled || type === 'first_message' || type === 'impersonate' || type === 'quiet') return;

    const context = getContext();
    const chat = context?.chat;
    if (!Array.isArray(chat) || !chat[messageId]) return;

    const msg = chat[messageId];
    if (msg.is_user || msg.is_system) return;

    const novelData = await loadNovelData();
    msg.extra = msg.extra || {};
    if (!msg.extra.novelContinuationOrigin) {
        msg.extra.novelContinuationOrigin = 'continued';
    }

    const chapterIndex = Number(msg.extra.novelChapterIndex)
        || Math.max(1, resolveCurrentTargetChapterIndex(chat, novelData, true));
    msg.extra.novelChapterIndex = chapterIndex;

    const extracted = extractNovelStateBlock(msg.mes);
    if (!extracted.hasState) {
        await context.saveChat?.();
        await refreshReaderWidgets();
        return;
    }

    msg.mes = extracted.cleanText;
    const swipeId = Number.isFinite(msg.swipe_id) ? msg.swipe_id : 0;
    if (Array.isArray(msg.swipes) && msg.swipes[swipeId] !== undefined) {
        msg.swipes[swipeId] = extracted.cleanText;
    }

    const stateRecord = {
        chapterIndex,
        summary: extracted.summary,
        worldUpdates: extracted.worldUpdates,
        hooks: extracted.hooks,
    };
    msg.extra.novelContinuationState = stateRecord;
    msg.extra.novelContinuationStateBySwipe = msg.extra.novelContinuationStateBySwipe || {};
    msg.extra.novelContinuationStateBySwipe[swipeId] = stateRecord;

    context.updateMessageBlock?.(messageId, msg);
    await context.saveChat?.();

    const firstLine = extracted.cleanText.split('\n').map(l => l.trim()).find(Boolean) || `第 ${chapterIndex} 章`;
    const chapterTitle = firstLine.replace(/^#+\s*/, '').slice(0, 40);

    await applyExtractedStateToLedger(extracted, chapterIndex, chapterTitle, messageId);

    if (settings.syncToWorldInfo && extracted.worldUpdates.length > 0) {
        try {
            await syncWorldUpdatesToTavernLorebook(novelData?.title, extracted.worldUpdates, chapterIndex);
        } catch (err) {
            console.warn('[小说续写阅读器] 同步至酒馆世界书失败：', err);
        }
    }

    await refreshReaderWidgets();
    await refreshSettingsStatusCard();
}

async function onMessageSwiped(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const context = getContext();
    const msg = context?.chat?.[messageId];
    if (!msg || msg.is_user) return;

    const swipeId = Number.isFinite(msg.swipe_id) ? msg.swipe_id : 0;
    const swipeState = msg.extra?.novelContinuationStateBySwipe?.[swipeId];
    const chapterIndex = Number(msg.extra?.novelChapterIndex);
    if (swipeState && chapterIndex > 0) {
        msg.extra.novelContinuationState = swipeState;
        const firstLine = String(msg.mes || '').split('\n').map(l => l.trim()).find(Boolean) || `第 ${chapterIndex} 章`;
        const chapterTitle = firstLine.replace(/^#+\s*/, '').slice(0, 40);
        await applyExtractedStateToLedger(swipeState, chapterIndex, chapterTitle, messageId);
        if (settings.syncToWorldInfo && swipeState.worldUpdates?.length > 0) {
            const novelData = await loadNovelData();
            await syncWorldUpdatesToTavernLorebook(novelData?.title, swipeState.worldUpdates, chapterIndex);
        }
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
    }
}

/**
 * Mounts the last N original chapters up to `cutoffChapterIndex` directly into `#chat`.
 */
async function mountOriginalAnchorChaptersToChat(novelData, cutoffChapterIndex) {
    const context = getContext();
    if (!context || !Array.isArray(context.chat) || !novelData?.chapters?.length) return;

    const settings = getSettings();
    const anchorCount = Math.max(1, Math.min(20, Number(settings.mountAnchorChapters) || 3));
    const cutoff = Math.min(novelData.chapters.length, Math.max(1, cutoffChapterIndex));
    const startIdx = Math.max(1, cutoff - anchorCount + 1);
    const selectedChapters = novelData.chapters.filter(c => c.index >= startIdx && c.index <= cutoff);

    // Keep only actual continued novel floors (drop standard card greeting chat[0] when importing a novel)
    const continuedTail = context.chat.filter(
        (m, idx) => m?.extra?.novelContinuationOrigin === 'continued' || (idx > 0 && m?.is_user),
    );
    const charName = context.name2 || novelData.title || '原著';

    const originalFloors = selectedChapters.map(ch => {
        const formatted = `### ${ch.title}\n\n${ch.content}`;
        return {
            name: charName,
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: formatted,
            swipes: [formatted],
            swipe_id: 0,
            extra: {
                novelContinuationOrigin: 'original',
                novelChapterIndex: ch.index,
                novelChapterTitle: ch.title,
            },
        };
    });

    context.chat.length = 0;
    for (const floor of [...originalFloors, ...continuedTail]) {
        context.chat.push(floor);
    }

    await context.saveChat?.();
    await context.printMessages?.();
    applyReaderBodyClasses(settings);
    if (originalFloors.length > 0) {
        await scrollToChatFloor(originalFloors.length - 1);
    }
}

async function handleCutoffFromChapter(targetChapterIndex) {
    const novelData = await loadNovelData();
    if (!novelData) return;

    const context = getContext();
    const hasAiFloors = Array.isArray(context?.chat) && context.chat.some(
        m => m?.extra?.novelContinuationOrigin === 'continued',
    );

    if (hasAiFloors) {
        const clearAi = window.confirm(
            `即将把《${novelData.title}》的续写起点截断至【第 ${targetChapterIndex} 章】（第 ${targetChapterIndex + 1} 章及之后的原著将被自动屏蔽防剧透）。\n\n是否同时清空当前聊天里已生成的旧续写楼层，从第 ${targetChapterIndex} 章干净重续？`,
        );
        if (clearAi && Array.isArray(context?.chat)) {
            const kept = context.chat.filter(m => m?.extra?.novelContinuationOrigin === 'original');
            context.chat.length = 0;
            kept.forEach(m => context.chat.push(m));
        }
    }

    novelData.cutoffChapterIndex = targetChapterIndex;
    await saveNovelData(novelData);
    await pruneLedgerAfterChapter(targetChapterIndex);
    clearReadingProgress();
    await mountOriginalAnchorChaptersToChat(novelData, targetChapterIndex);
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();
    globalThis.toastr?.success?.(
        `已截断至第 ${targetChapterIndex} 章，后续原著章节与未来状态已清理，现在可直接从该章往下续写！`,
        '小说续写阅读器',
    );
}

async function extractCutoffSnapshotSingleCall(btnEl) {
    const novelData = await loadNovelData();
    if (!novelData?.chapters?.length) {
        globalThis.toastr?.warning?.('请先导入小说 TXT/MD 文件', '小说续写阅读器');
        return;
    }

    const context = getContext();
    if (typeof context?.generateRaw !== 'function') {
        globalThis.toastr?.error?.('当前环境不支持 generateRaw 单次调用', '小说续写阅读器');
        return;
    }

    const cutoff = novelData.cutoffChapterIndex || novelData.totalChapters;
    const sampleChapters = novelData.chapters
        .filter(c => c.index >= Math.max(1, cutoff - 1) && c.index <= cutoff)
        .map(c => `【${c.title}】\n${c.content.slice(-3500)}`)
        .join('\n\n');

    const prompt = [
        `你是一位严谨的长篇小说总编。以下是《${novelData.title}》截止到第 ${cutoff} 章（断更处）的末尾原文。`,
        '请只用这一次回复，盘点断更现场的状态，严格只输出一个 `<novel_state>` XML 块：',
        '<novel_state>',
        `<summary>截止第${cutoff}章的当前所处场景、冲突焦点与前情核心梗概（150字内）</summary>`,
        '<worldbook>',
        '- 人物|主角及当前登场核心角色：身份、当前境界/能力、持有关键物品、人际关系与位置',
        '- 设定|当前地图或势力：当前剧情所处势力或危机局势',
        '</worldbook>',
        '<hooks>',
        '- [新伏笔] 当前尚未解决的悬念或即将爆发的冲突1',
        '- [新伏笔] 当前尚未解决的悬念或暗线2',
        '</hooks>',
        '</novel_state>',
        '',
        '【断更处原文】：',
        sampleChapters,
    ].join('\n');

    const origText = btnEl ? btnEl.textContent : '';
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '⏳ 正在单次提炼断更现场...';
    }

    try {
        const response = await context.generateRaw({
            prompt,
            systemPrompt: '请严格输出 <novel_state>...</novel_state> 标签块。',
        });
        const extracted = extractNovelStateBlock(String(response || ''));
        if (!extracted.hasState) throw new Error('模型未按 <novel_state> 格式返回，请重试');
        await applyExtractedStateToLedger(extracted, cutoff, `第 ${cutoff} 章断更现场`);
        if (getSettings().syncToWorldInfo && extracted.worldUpdates.length > 0) {
            await syncWorldUpdatesToTavernLorebook(novelData.title, extracted.worldUpdates, cutoff);
        }
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
        globalThis.toastr?.success?.('断更现场的人物状态、总结与待填伏笔已提取完毕！', '小说续写阅读器');
    } catch (error) {
        globalThis.toastr?.error?.(`提炼失败：${error?.message || error}`, '小说续写阅读器');
    } finally {
        if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = origText;
        }
    }
}

function mountSettingsPanel() {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container || document.getElementById('tt_novel_continuation_panel')) return;

    const settings = getSettings();
    const wrapper = document.createElement('div');
    wrapper.id = 'tt_novel_continuation_panel';
    wrapper.className = 'inline-drawer';
    wrapper.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>📖 小说续写阅读器 (太监/同人单次续写)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content tt-novel-settings-body">
            <div id="tt-novel-status-card" class="tt-novel-status-card">正在读取当前聊天书籍状态...</div>
            <div class="tt-novel-btn-group">
                <label class="menu_button tt-novel-file-label">
                    <i class="fa-solid fa-file-import"></i> 导入太监/同人小说 (.txt/.md)
                    <input type="file" id="tt-novel-import-txt" accept=".txt,.md,text/plain,text/markdown,*/*" hidden />
                </label>
                <label class="menu_button tt-novel-file-label">
                    <i class="fa-solid fa-database"></i> 挂载同人补充设定库 (.json/.md/.txt)
                    <input type="file" id="tt-novel-import-canon" accept=".json,.jsonl,.md,.txt,application/json,text/plain,*/*" multiple hidden />
                </label>
            </div>
            <div class="tt-novel-btn-group">
                <button type="button" id="tt-novel-extract-cutoff" class="menu_button">⚡ 提炼断更现场状态 (仅调 1 次 API)</button>
                <button type="button" id="tt-novel-open-toc" class="menu_button">📑 打开章节目录与截断跳转</button>
            </div>
            <hr />
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-chk-enabled" ${settings.enabled ? 'checked' : ''} />
                <span>启用小说续写插件（关闭时彻底还原普通酒馆聊天与排版）</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-chk-immersive" ${settings.immersiveMode ? 'checked' : ''} />
                <span>开启「沉浸小说阅读模式」（隐藏头像、名字与气泡框，连续书页排版）</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-chk-hide-user" ${settings.hideUserFloors ? 'checked' : ''} />
                <span>自动隐藏所有「用户指令楼层」（让原著与续写章节无缝相连）</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-chk-hide-cot" ${settings.hideReasoning !== false ? 'checked' : ''} />
                <span>自动隐藏「AI 思维链与思考批注框」（隐藏思考批注及预设折叠思维链）</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-chk-autostate" ${settings.enableAutoStateBlock ? 'checked' : ''} />
                <span>单次生成末尾顺带产出总结、人物状态与伏笔更新（0 额外 API 调用）</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-chk-sync-wi" ${settings.syncToWorldInfo ? 'checked' : ''} />
                <span>自动将提取的人物/势力状态同步写入酒馆原生世界书 (World Info)</span>
            </label>
            <div class="tt-novel-inline-field">
                <span>导入/截断时铺入聊天的原著末尾章数：</span>
                <input type="number" id="tt-novel-anchor-count" class="text_pole" min="1" max="20" value="${settings.mountAnchorChapters}" />
            </div>
            <div class="tt-novel-btn-group">
                <button type="button" id="tt-novel-clear-canon" class="menu_button">清空补充设定库</button>
                <button type="button" id="tt-novel-clear-all" class="menu_button">重置当前聊天小说数据</button>
            </div>
            <hr />
            <div class="tt-novel-bridge-box">
                <div><b>🔌 外部 Agent 远程介入桥 (WebSocket / MCP)</b></div>
                <div class="tt-novel-bridge-row">
                    <input type="text" id="tt-novel-bridge-url" class="text_pole" placeholder="ws://电脑局域网IP:17890/ws" value="${escapeHtml(settings.remoteBridgeUrl || '')}" />
                    <button type="button" id="tt-novel-bridge-connect" class="menu_button">🔗 连接</button>
                    <button type="button" id="tt-novel-bridge-disconnect" class="menu_button">⏹ 断开</button>
                </div>
                <small id="tt-novel-bridge-status" class="tt-novel-bridge-status">⚪ 未连接外部 Agent</small>
            </div>
        </div>
    `;

    container.appendChild(wrapper);
    bindSettingsEvents(wrapper);
    refreshSettingsStatusCard();
}

function bindSettingsEvents(wrapper) {
    const settings = getSettings();

    wrapper.querySelector('#tt-novel-import-txt')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const novelData = parseNovelTxt(await file.text(), file.name);
        if (novelData.totalChapters === 0) {
            globalThis.toastr?.warning?.('未能在文件中解析出有效文本内容', '小说续写阅读器');
            return;
        }
        await saveNovelData(novelData);
        await mountOriginalAnchorChaptersToChat(novelData, novelData.cutoffChapterIndex);
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
        globalThis.toastr?.success?.(
            `已导入《${novelData.title}》（共 ${novelData.totalChapters} 章），并将最后 ${settings.mountAnchorChapters} 章铺入当前聊天！`,
            '小说续写阅读器',
        );
        e.target.value = '';
    });

    wrapper.querySelector('#tt-novel-import-canon')?.addEventListener('change', async (e) => {
        const files = [...(e.target.files || [])];
        if (files.length === 0) return;
        const canonDb = await loadCanonDb();
        let addedCount = 0;
        for (const file of files) {
            const parsedItems = parseSupplementaryDatabase(await file.text(), file.name);
            if (parsedItems.length > 0) {
                canonDb.sources = [...new Set([...(canonDb.sources || []), file.name])];
                canonDb.items.push(...parsedItems);
                addedCount += parsedItems.length;
            }
        }
        await saveCanonDb(canonDb);
        await refreshSettingsStatusCard();
        globalThis.toastr?.success?.(`已挂载 ${addedCount} 条同人补充原作设定词条！`, '小说续写阅读器');
        e.target.value = '';
    });

    wrapper.querySelector('#tt-novel-extract-cutoff')?.addEventListener('click', (e) => extractCutoffSnapshotSingleCall(e.currentTarget));
    wrapper.querySelector('#tt-novel-open-toc')?.addEventListener('click', () => toggleTocDrawer(true));

    const bindCheckbox = (selector, key) => {
        wrapper.querySelector(selector)?.addEventListener('change', (e) => {
            settings[key] = Boolean(e.target.checked);
            saveExtensionSettings();
            if (key === 'enabled' && !settings.enabled) {
                getContext()?.setExtensionPrompt?.(EXTENSION_PROMPT_TAG, '', extension_prompt_types.NONE, 0);
            }
            applyReaderBodyClasses(settings);
        });
    };

    bindCheckbox('#tt-novel-chk-enabled', 'enabled');
    bindCheckbox('#tt-novel-chk-immersive', 'immersiveMode');
    bindCheckbox('#tt-novel-chk-hide-user', 'hideUserFloors');
    bindCheckbox('#tt-novel-chk-hide-cot', 'hideReasoning');
    bindCheckbox('#tt-novel-chk-autostate', 'enableAutoStateBlock');
    bindCheckbox('#tt-novel-chk-sync-wi', 'syncToWorldInfo');

    wrapper.querySelector('#tt-novel-anchor-count')?.addEventListener('change', (e) => {
        settings.mountAnchorChapters = Math.max(1, Math.min(20, Number(e.target.value) || 3));
        saveExtensionSettings();
    });

    wrapper.querySelector('#tt-novel-clear-canon')?.addEventListener('click', async () => {
        await saveCanonDb(createEmptyCanonDb());
        await refreshSettingsStatusCard();
        globalThis.toastr?.info?.('已清空当前聊天的同人补充设定库', '小说续写阅读器');
    });

    wrapper.querySelector('#tt-novel-clear-all')?.addEventListener('click', async () => {
        if (!window.confirm('确定清空当前聊天导入的原著、时间线总结与伏笔记录吗？')) return;
        await clearNovelData();
        await saveLedger(createEmptyLedger());
        await saveCanonDb(createEmptyCanonDb());
        clearReadingProgress();
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
    });

    const updateBridgeUi = ({ state, detail }) => {
        const statusEl = document.getElementById('tt-novel-bridge-status');
        if (!statusEl) return;
        const icon = state === 'connected' ? '🟢' : (state === 'connecting' ? '🟡' : (state === 'error' ? '🔴' : '⚪'));
        statusEl.textContent = `${icon} ${detail || state}`;
    };

    wrapper.querySelector('#tt-novel-bridge-connect')?.addEventListener('click', () => {
        const inputEl = /** @type {HTMLInputElement | null} */ (document.getElementById('tt-novel-bridge-url'));
        const url = String(inputEl?.value || '').trim();
        settings.remoteBridgeUrl = url;
        saveExtensionSettings();
        connectRemoteBridge(url, { getSettings, saveExtensionSettings }, updateBridgeUi);
    });

    wrapper.querySelector('#tt-novel-bridge-disconnect')?.addEventListener('click', () => {
        disconnectRemoteBridge();
    });
}

async function refreshSettingsStatusCard() {
    const card = document.getElementById('tt-novel-status-card');
    if (!card) return;

    const [novelData, ledger, canonDb] = await Promise.all([loadNovelData(), loadLedger(), loadCanonDb()]);
    const openHooksCount = (ledger?.hooks || []).filter(h => h.status !== 'resolved').length;
    const novelLine = novelData
        ? `📚 <b>当前原著</b>：《${escapeHtml(novelData.title)}》（共 ${novelData.totalChapters} 章 · 续写锚点：第 ${novelData.cutoffChapterIndex} 章）`
        : '📚 <b>当前原著</b>：尚未导入（可导入 .txt/.md 太监或同人小说）';
    const ledgerLine = `🧠 <b>时间线记忆</b>：${ledger.summaries.length} 章总结 · ${ledger.worldStates.length} 条人物/世界状态 · ${openHooksCount} 条待填伏笔`;
    const canonLine = `🗂️ <b>同人补充数据库</b>：已挂载 ${canonDb.items.length} 个设定词条${canonDb.sources.length ? `（${escapeHtml(canonDb.sources.join(', '))}）` : ''}`;

    card.innerHTML = `<div>${novelLine}</div><div>${ledgerLine}</div><div>${canonLine}</div>`;
}

function handleToggleSetting(key) {
    const settings = getSettings();
    settings[key] = !settings[key];
    saveExtensionSettings();
    applyReaderBodyClasses(settings);
    const chkMap = {
        immersiveMode: '#tt-novel-chk-immersive',
        hideUserFloors: '#tt-novel-chk-hide-user',
        hideReasoning: '#tt-novel-chk-hide-cot',
    };
    const chk = document.querySelector(chkMap[key]);
    if (chk) chk.checked = settings[key];
}

let initialized = false;

export async function init() {
    if (initialized) return;
    initialized = true;

    const context = getContext();
    const settings = getSettings();

    mountSettingsPanel();
    mountReaderUi({ settings, onToggleSetting: handleToggleSetting, onCutoffFromChapter: handleCutoffFromChapter });
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();

    const { eventSource, eventTypes } = context;
    if (eventSource && eventTypes) {
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        if (eventTypes.MESSAGE_SWIPED) {
            eventSource.on(eventTypes.MESSAGE_SWIPED, onMessageSwiped);
        }
        eventSource.on(eventTypes.CHAT_CHANGED, async () => {
            applyReaderBodyClasses(getSettings());
            await refreshReaderWidgets();
            await refreshSettingsStatusCard();
        });
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { void init(); }, { once: true });
    } else {
        void init();
    }
}
