import { extension_settings, getContext } from '/scripts/extensions.js';
import { extension_prompt_roles, extension_prompt_types } from '/scripts/extension-prompts.js';
import { oai_settings } from '/scripts/openai.js';
import { deleteMessage, resetChatSurfaceView } from '/script.js';
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
import { runStyleDistillationPipeline } from './style-distiller.js';

const SETTINGS_KEY = 'novel_continuation';
const EXTENSION_PROMPT_TAG = 'novel_continuation_golden_context';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    immersiveMode: true,
    hideUserFloors: true,
    hideReasoning: true,
    authorMode: true,
    foldUserOutlineFloors: true,
    enableAutoStateBlock: true,
    syncToWorldInfo: true,
    mountAnchorChapters: 3,
    distillRounds: 2,
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
        // Keep the latest `mountAnchorChapters` (default 3, up to 20) original chapters in `coreChat`
        // AND merge consecutive original chapter floors into ONE continuous assistant message.
        // Merging prevents RP preset processors (like Meowssiah/SPreset `foreignArchivedBlocks.slice(0, 180)`)
        // from mistaking multiple consecutive assistant floors for foreign archive turns and truncating the cutoff chapter!
        if (Array.isArray(chat)) {
            const anchorLimit = Math.max(1, Math.min(20, Number(settings.mountAnchorChapters) || 3));
            const origPositions = [];
            chat.forEach((m, idx) => {
                if (m?.extra?.novelContinuationOrigin === 'original') {
                    origPositions.push(idx);
                }
            });
            if (origPositions.length > 0) {
                const keptPositions = origPositions.slice(-anchorLimit);
                const firstKeptPos = keptPositions[0];
                const mergedText = keptPositions
                    .map(pos => String(chat[pos]?.mes || '').trim())
                    .filter(Boolean)
                    .join('\n\n---\n\n');
                const lastKeptMsg = chat[keptPositions[keptPositions.length - 1]];
                const mergedOrigMsg = {
                    ...lastKeptMsg,
                    mes: mergedText,
                    extra: {
                        ...(lastKeptMsg?.extra || {}),
                        novelContinuationOrigin: 'original',
                        novelMergedChapterCount: keptPositions.length,
                    },
                };
                // Replace firstKeptPos with the merged message and remove all other original positions
                const removeSet = new Set(origPositions.filter(pos => pos !== firstKeptPos));
                chat[firstKeptPos] = mergedOrigMsg;
                for (let i = chat.length - 1; i >= 0; i -= 1) {
                    if (removeSet.has(i)) {
                        chat.splice(i, 1);
                    }
                }
            }
        }

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
            if (settings.authorMode !== false) {
                // Suppress Tavern Persona Description injection during novel generation
                context?.setExtensionPrompt?.('PERSONA_DESCRIPTION', '', extension_prompt_types.NONE, 0);

                // If swiping/regenerating a chapter whose preceding user outline floor was folded,
                // restore its archived `novelAuthorOutline` into the temporary `coreChat` prompt copy!
                if (Array.isArray(chat) && (type === 'swipe' || type === 'regenerate')) {
                    const lastInLiveChat = Array.isArray(context?.chat) ? context.chat[context.chat.length - 1] : null;
                    const archivedOutline = String(lastInLiveChat?.extra?.novelAuthorOutline || '').trim();
                    const coreEndsWithUser = chat.length > 0 && Boolean(chat[chat.length - 1]?.is_user);
                    if (archivedOutline && !coreEndsWithUser) {
                        chat.push({
                            name: context?.name1 || '作者',
                            is_user: true,
                            is_system: false,
                            mes: archivedOutline,
                        });
                    }
                }

                // Wrap user outline inputs in the temporary `coreChat` copy as Author/Director instructions
                if (Array.isArray(chat)) {
                    for (const msg of chat) {
                        if (msg?.is_user && typeof msg.mes === 'string' && msg.mes.trim() && !msg.mes.startsWith('【作者/总编')) {
                            msg.mes = `【作者/总编的本章执笔大纲指令（仅供AI遵照执笔，非剧中人台词，剧情中不存在玩家或{{user}}角色）】：\n${msg.mes.trim()}`;
                        }
                    }
                }
            }

            const lastMsgIsUser = Array.isArray(chat) && chat.length > 0 && Boolean(chat[chat.length - 1]?.is_user);
            const injectDepth = lastMsgIsUser ? 1 : 0;
            context?.setExtensionPrompt?.(
                EXTENSION_PROMPT_TAG,
                promptBlock,
                extension_prompt_types.IN_CHAT,
                injectDepth,
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
 * After TauriTavern finishes finalizing/saving a newly generated AI chapter floor,
 * archives the immediately preceding user outline message into `msgRef.extra.novelAuthorOutline`
 * and removes that temporary user floor via `deleteMessage()` so Floor `#N` remains strictly
 * 1-to-1 aligned with Chapter `N` even across unlimited AI continuations.
 *
 * @param {any} msgRef
 */
function scheduleFoldPrecedingUserOutlineFloor(msgRef) {
    setTimeout(async () => {
        const settings = getSettings();
        if (!settings.enabled || settings.authorMode === false || settings.foldUserOutlineFloors === false) return;

        const context = getContext();
        const chat = context?.chat;
        if (!Array.isArray(chat)) return;

        const currentIdx = chat.indexOf(msgRef);
        if (currentIdx < 1) return;
        if (!String(msgRef?.mes || '').trim()) return;

        const prevMsg = chat[currentIdx - 1];
        if (!prevMsg?.is_user) return;

        const novelData = await loadNovelData();
        if (!novelData?.chapters?.length) return;

        msgRef.extra = msgRef.extra || {};
        if (typeof prevMsg.mes === 'string' && prevMsg.mes.trim()) {
            msgRef.extra.novelAuthorOutline = prevMsg.mes.trim();
        }

        try {
            await deleteMessage(currentIdx - 1, undefined, false);
            await refreshReaderWidgets();
        } catch (err) {
            console.warn('[小说续写阅读器] 自动折叠用户大纲楼层失败：', err);
        }
    }, 260);
}

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

    const shouldFoldUserOutline = Boolean(
        novelData?.chapters?.length
        && settings.authorMode !== false
        && settings.foldUserOutlineFloors !== false
        && type !== 'continue',
    );

    const extracted = extractNovelStateBlock(msg.mes);
    if (!extracted.hasState) {
        await context.saveChat?.();
        await refreshReaderWidgets();
        if (shouldFoldUserOutline) {
            scheduleFoldPrecedingUserOutlineFloor(msg);
        }
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

    if (shouldFoldUserOutline) {
        scheduleFoldPrecedingUserOutlineFloor(msg);
    }
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

function createOriginalChapterFloor(ch, charName) {
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
}

function createBookCoverFloor(novelData, maxChapter, charName) {
    const sampleTitle = novelData.chapters?.[0]?.title || '';
    const unit = /节\s*$/.test(sampleTitle.trim()) ? '节' : '章';
    const text = `📖 **《${novelData.title}》**\n\n共 ${novelData.totalChapters} ${unit} · 当前夺舍节点：第 ${maxChapter} ${unit}（楼层 #1 ~ #${maxChapter} 与原著第 1 ~ ${maxChapter} ${unit} 一一对应）`;
    return {
        name: charName,
        is_user: false,
        is_system: true,
        send_date: Date.now(),
        mes: text,
        swipes: [text],
        swipe_id: 0,
        extra: {
            novelContinuationOrigin: 'cover',
            isSmallSys: true,
        },
    };
}

/**
 * Mounts `#0` book cover (`is_system: true`, 0 LLM tokens) + all original chapters `1 .. upToChapterIndex`
 * into `context.chat[1 .. upToChapterIndex]` so Floor `#N` strictly equals Chapter `N`,
 * relying on TauriTavern's native `BoundedChatSurface` virtualization to manage high floor counts.
 */
async function mountOriginalAnchorChaptersToChat(novelData, upToChapterIndex, { focusChapterIndex = null } = {}) {
    const context = getContext();
    if (!context || !Array.isArray(context.chat) || !novelData?.chapters?.length) return;

    const settings = getSettings();
    const maxChapter = Math.min(novelData.chapters.length, Math.max(1, upToChapterIndex));
    const focusTarget = focusChapterIndex
        ? Math.min(maxChapter, Math.max(1, focusChapterIndex))
        : maxChapter;
    const selectedChapters = novelData.chapters.filter(c => c.index >= 1 && c.index <= maxChapter);

    const continuedTail = context.chat.filter(
        (m, idx) => m?.extra?.novelContinuationOrigin === 'continued' || (idx > 0 && m?.is_user),
    );
    const charName = context.name2 || novelData.title || '原著';
    const coverFloor = createBookCoverFloor(novelData, maxChapter, charName);
    const originalFloors = selectedChapters.map(ch => createOriginalChapterFloor(ch, charName));

    context.chat.length = 0;
    context.chat.push(coverFloor);
    for (const floor of [...originalFloors, ...continuedTail]) {
        context.chat.push(floor);
    }

    if (context.chatMetadata) {
        context.chatMetadata.tainted = true;
    }
    try {
        await context.saveMetadata?.();
        await context.saveChat?.();
    } catch {
        // Ignore save errors on temporary welcome screen
    }
    // Reset TauriTavern's mounted floor ID cache before printMessages() so newly added chapters
    // beyond the previous chat's floor count (e.g. floors #9..#17 after an 8-floor chat) are all rendered!
    try {
        resetChatSurfaceView?.({ includeAuxiliary: true });
    } catch {
        // Ignore if surface is not yet initialized
    }
    await context.printMessages?.();
    applyReaderBodyClasses(settings);

    const targetFloorIdx = context.chat.findIndex(
        f => f?.extra?.novelContinuationOrigin === 'original' && f?.extra?.novelChapterIndex === focusTarget,
    );
    if (targetFloorIdx >= 0) {
        await scrollToChatFloor(targetFloorIdx);
    } else if (context.chat.length > 1) {
        await scrollToChatFloor(context.chat.length - 1);
    }
}

/**
 * Jumps directly to any user-selected chapter `targetChapterIndex` in the main `#chat` reader.
 */
async function handleViewOriginalChapter(targetChapterIndex) {
    const novelData = await loadNovelData();
    if (!novelData) return;

    const context = getContext();
    const chat = context?.chat || [];
    const existingFloorIdx = chat.findIndex(
        m => m?.extra?.novelContinuationOrigin === 'original' && Number(m?.extra?.novelChapterIndex) === targetChapterIndex,
    );

    novelData.viewingChapterIndex = targetChapterIndex;
    await saveNovelData(novelData);

    if (existingFloorIdx >= 0) {
        await scrollToChatFloor(existingFloorIdx);
        await refreshReaderWidgets();
        return;
    }

    const cutoff = Number(novelData.cutoffChapterIndex || novelData.totalChapters);
    const upTo = Math.max(cutoff, targetChapterIndex);
    await mountOriginalAnchorChaptersToChat(novelData, upTo, { focusChapterIndex: targetChapterIndex });
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();
}

/**
 * Automatically restores the imported novel chapters into `#chat` when re-entering a blank character card
 * or reopening the app if `#chat` was reset to empty/greeting-only.
 */
async function restoreNovelFloorsIfNeeded() {
    const settings = getSettings();
    if (!settings.enabled) return;
    const context = getContext();
    if (!Array.isArray(context?.chat)) return;

    const hasOriginalFloors = context.chat.some(m => m?.extra?.novelContinuationOrigin === 'original');
    if (hasOriginalFloors) return;

    // Only auto-mount into blank or greeting-only chats (<= 1 message and no user messages yet)
    const hasUserMessages = context.chat.some(m => m?.is_user);
    if (context.chat.length > 1 || hasUserMessages) return;

    const novelData = await loadNovelData();
    if (!novelData?.chapters?.length) return;

    const cutoff = novelData.cutoffChapterIndex || novelData.totalChapters;
    const focusChapter = novelData.viewingChapterIndex || cutoff;
    await mountOriginalAnchorChaptersToChat(novelData, cutoff, { focusChapterIndex: focusChapter });
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
            `即将从【第 ${targetChapterIndex} 章】开始夺舍重续（第 1~${targetChapterIndex} 章全部导入聊天，第 ${targetChapterIndex + 1} 章及之后的原著将被自动屏蔽防剧透）。\n\n是否同时清空当前聊天里已生成的旧续写楼层，从第 ${targetChapterIndex} 章干净重续？`,
        );
        if (clearAi && Array.isArray(context?.chat)) {
            const kept = context.chat.filter(m => m?.extra?.novelContinuationOrigin === 'original');
            context.chat.length = 0;
            kept.forEach(m => context.chat.push(m));
        }
    }

    novelData.cutoffChapterIndex = targetChapterIndex;
    novelData.viewingChapterIndex = targetChapterIndex;
    await saveNovelData(novelData);
    await pruneLedgerAfterChapter(targetChapterIndex);
    clearReadingProgress();
    await mountOriginalAnchorChaptersToChat(novelData, targetChapterIndex, { focusChapterIndex: targetChapterIndex });
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();
    globalThis.toastr?.success?.(
        `已截断至第 ${targetChapterIndex} 章（第 1~${targetChapterIndex} 章已全部导入聊天，由酒馆自动管理高楼层），现在可直接往下续写！`,
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

function getActiveApiModelLabel() {
    try {
        const src = String(oai_settings?.chat_completion_source || '').trim();
        const modelMap = {
            custom: oai_settings?.custom_model,
            openai: oai_settings?.openai_model,
            claude: oai_settings?.claude_model,
            makersuite: oai_settings?.google_model,
            vertexai: oai_settings?.vertexai_model,
            openrouter: oai_settings?.openrouter_model,
            deepseek: oai_settings?.deepseek_model,
            xai: oai_settings?.xai_model,
            groq: oai_settings?.groq_model,
            mistralai: oai_settings?.mistralai_model,
        };
        const model = String(modelMap[src] || oai_settings?.custom_model || oai_settings?.openai_model || '').trim();
        if (src && model) return `${src} / ${model}`;
        if (model) return model;
        if (src) return src;
    } catch {
        // Ignore if oai_settings unavailable
    }
    return '当前酒馆已连接模型';
}

async function distillNovelStyleAdversarial(btnEl, { incremental = false } = {}) {
    const novelData = await loadNovelData();
    if (!novelData?.chapters?.length) {
        globalThis.toastr?.warning?.('请先导入原著小说 TXT/MD 文件', '小说续写阅读器');
        return;
    }

    const context = getContext();
    if (typeof context?.generateRaw !== 'function') {
        globalThis.toastr?.error?.('当前环境不支持 generateRaw 模型调用', '小说续写阅读器');
        return;
    }

    const settings = getSettings();
    const ledger = await loadLedger();
    if (incremental && !ledger?.styleProfile?.styleCard) {
        globalThis.toastr?.warning?.('请先执行一次完整文风蒸馏，再追加精炼轮次', '小说续写阅读器');
        return;
    }

    const rounds = Math.max(1, Math.min(3, Number(settings.distillRounds) || 2));
    const modelLabel = getActiveApiModelLabel();
    const origText = btnEl ? btnEl.textContent : '';
    const progressEl = document.getElementById('tt-novel-style-progress');
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = incremental ? '🔄 正在追加盲测精炼...' : '🎨 正在多轮对抗蒸馏...';
    }
    if (progressEl) {
        progressEl.classList.remove('displayNone');
        progressEl.textContent = incremental
            ? `⏳ 使用 [${modelLabel}] 追加 1 轮全新真迹盲测与对比评分...`
            : `⏳ 使用 [${modelLabel}] 启动 ${rounds} 轮对抗盲测蒸馏（并发上限 ≤ 2）...`;
    }

    try {
        const styleProfile = await runStyleDistillationPipeline({
            novelData,
            maxConcurrency: 2,
            rounds,
            existingProfile: incremental ? ledger.styleProfile : null,
            callModel: async ({ prompt, systemPrompt }) => {
                const reply = await context.generateRaw({ prompt, systemPrompt });
                return String(reply || '');
            },
            onProgress: ({ step, totalSteps, label }) => {
                if (progressEl) {
                    progressEl.textContent = `⏳ [${modelLabel}] [${step}/${totalSteps}] ${label}`;
                }
            },
        });

        ledger.styleProfile = styleProfile;
        await saveLedger(ledger);
        await refreshSettingsStatusCard();
        await refreshReaderWidgets();

        const scoreChain = (styleProfile.roundHistory || [])
            .map(r => `第${r.round}轮 ${r.score !== null ? `${r.score}分` : '?'}`)
            .join(' → ');
        if (progressEl) {
            progressEl.textContent = `✅ 蒸馏完成（${String(styleProfile.styleCard).length} 字 · ${scoreChain || '已定稿'}）！后续每章续写自动生效。`;
        }
        globalThis.toastr?.success?.(
            `原著文风蒸馏完成（${scoreChain || '已定稿'}），已永久绑定到当前对话！`,
            '小说续写阅读器',
        );
    } catch (error) {
        if (progressEl) {
            progressEl.textContent = `❌ 蒸馏失败：${error?.message || error}`;
        }
        globalThis.toastr?.error?.(`文风蒸馏失败：${error?.message || error}`, '小说续写阅读器');
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
                <button type="button" id="tt-novel-distill-style" class="menu_button">🎨 深度蒸馏原著文风 (多轮对抗 · 并发≤2)</button>
                <button type="button" id="tt-novel-extract-cutoff" class="menu_button">⚡ 提炼断更现场状态 (仅调 1 次 API)</button>
                <button type="button" id="tt-novel-open-toc" class="menu_button">📑 打开章节目录与截断跳转</button>
            </div>
            <div class="tt-novel-inline-field">
                <span>文风对抗盲测迭代轮数（每轮换新真迹对比打分，≥92分提前达标）：</span>
                <select id="tt-novel-distill-rounds" class="text_pole" style="width: 88px;">
                    <option value="1" ${Number(settings.distillRounds) === 1 ? 'selected' : ''}>1 轮</option>
                    <option value="2" ${Number(settings.distillRounds || 2) === 2 ? 'selected' : ''}>2 轮 (推荐)</option>
                    <option value="3" ${Number(settings.distillRounds) === 3 ? 'selected' : ''}>3 轮 (深度)</option>
                </select>
            </div>
            <div id="tt-novel-style-progress" class="tt-novel-style-progress displayNone"></div>
            <details id="tt-novel-style-drawer" class="tt-novel-style-drawer">
                <summary>🧬 查看 / 手动微调《原著文风 DNA 圣经》与多轮盲测评分报告</summary>
                <div class="tt-novel-style-drawer-body">
                    <div id="tt-novel-style-diff" class="tt-novel-style-diff">尚未执行文风蒸馏。蒸馏默认直接调用你当前酒馆顶部 API 连接面板里选中的模型。</div>
                    <textarea id="tt-novel-style-editor" class="text_pole tt-novel-style-editor" rows="9" placeholder="蒸馏生成的《原著文风 DNA 圣经》（约 1800~2800 字）会显示在这里，你也可以手动微调任意一条规则后保存..."></textarea>
                    <div class="tt-novel-btn-group">
                        <button type="button" id="tt-novel-refine-style" class="menu_button">🔄 再追加 1 轮盲测精炼</button>
                        <button type="button" id="tt-novel-save-style" class="menu_button">💾 保存文风修改</button>
                        <button type="button" id="tt-novel-clear-style" class="menu_button">🗑️ 清空文风卡</button>
                    </div>
                </div>
            </details>
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
                <input type="checkbox" id="tt-novel-chk-author-mode" ${settings.authorMode !== false ? 'checked' : ''} />
                <span>开启「✍️ 作者境界」（屏蔽酒馆玩家 {{user}} 人设与 RP 规则，将输入自动转为导演大纲）</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-chk-fold-user" ${settings.foldUserOutlineFloors !== false ? 'checked' : ''} />
                <span>续写完成后自动折叠「用户大纲楼层」（大纲归档进该章元数据，让楼层号与章节号永远 1:1 严格对应）</span>
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
                <span>续写时直接发给 AI 的末尾原著章数：</span>
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
        try {
            const context = getContext();
            const hasActiveConversation = Boolean(
                context?.chatId
                || context?.getCurrentChatId?.()
                || context?.groupId
                || (context?.characterId !== undefined && context?.characterId !== null),
            );
            if (!hasActiveConversation) {
                globalThis.toastr?.warning?.('请先打开一个角色卡并进入具体对话后再导入小说（小说数据按对话独立绑定）', '小说续写阅读器');
                return;
            }
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
                `已绑定当前对话并导入《${novelData.title}》（共 ${novelData.totalChapters} 章，#1~#${novelData.totalChapters} 一一对应）！`,
                '小说续写阅读器',
            );
        } catch (err) {
            globalThis.toastr?.error?.(`导入失败：${err?.message || err}`, '小说续写阅读器');
        } finally {
            e.target.value = '';
        }
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

    wrapper.querySelector('#tt-novel-distill-style')?.addEventListener('click', (e) => distillNovelStyleAdversarial(e.currentTarget, { incremental: false }));
    wrapper.querySelector('#tt-novel-refine-style')?.addEventListener('click', (e) => distillNovelStyleAdversarial(e.currentTarget, { incremental: true }));
    wrapper.querySelector('#tt-novel-distill-rounds')?.addEventListener('change', (e) => {
        settings.distillRounds = Math.max(1, Math.min(3, Number(e.target.value) || 2));
        saveExtensionSettings();
    });
    wrapper.querySelector('#tt-novel-extract-cutoff')?.addEventListener('click', (e) => extractCutoffSnapshotSingleCall(e.currentTarget));
    wrapper.querySelector('#tt-novel-open-toc')?.addEventListener('click', () => toggleTocDrawer(true));

    wrapper.querySelector('#tt-novel-save-style')?.addEventListener('click', async () => {
        const editorEl = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('tt-novel-style-editor'));
        const text = String(editorEl?.value || '').trim();
        const ledger = await loadLedger();
        if (!text) {
            ledger.styleProfile = null;
        } else {
            ledger.styleProfile = {
                ...(ledger.styleProfile || { version: 1, fingerprintText: '', goldenExcerpts: '', diffFindings: '' }),
                styleCard: text,
                distilledAt: Date.now(),
            };
        }
        await saveLedger(ledger);
        await refreshSettingsStatusCard();
        globalThis.toastr?.success?.(text ? '已保存修改后的《原著文风 DNA 卡》！' : '已清空文风卡', '小说续写阅读器');
    });

    wrapper.querySelector('#tt-novel-clear-style')?.addEventListener('click', async () => {
        const ledger = await loadLedger();
        ledger.styleProfile = null;
        await saveLedger(ledger);
        await refreshSettingsStatusCard();
        globalThis.toastr?.info?.('已清空当前书籍的原著文风 DNA 卡', '小说续写阅读器');
    });

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
    bindCheckbox('#tt-novel-chk-author-mode', 'authorMode');
    bindCheckbox('#tt-novel-chk-fold-user', 'foldUserOutlineFloors');
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
    const sp = ledger?.styleProfile;
    const activeModel = getActiveApiModelLabel();
    const novelLine = novelData
        ? `📚 <b>当前原著</b>：《${escapeHtml(novelData.title)}》（共 ${novelData.totalChapters} 章 · 续写锚点：第 ${novelData.cutoffChapterIndex} 章）`
        : '📚 <b>当前原著</b>：尚未导入（可导入 .txt/.md 太监或同人小说）';
    const scoreChain = Array.isArray(sp?.roundHistory) && sp.roundHistory.length > 0
        ? ` · 盲测评分：${sp.roundHistory.map(r => `R${r.round} ${r.score !== null ? `${r.score}分` : '?'}`).join(' → ')}`
        : '';
    const styleLine = sp?.styleCard
        ? `🎨 <b>原著文风 DNA</b>：已定稿（${String(sp.styleCard).length} 字${escapeHtml(scoreChain)}）`
        : '🎨 <b>原著文风 DNA</b>：尚未蒸馏（点击「🎨 深度蒸馏原著文风」可多轮对抗提取）';
    const modelLine = `🤖 <b>当前蒸馏/续写模型</b>：<code>${escapeHtml(activeModel)}</code>（跟随酒馆顶部 API 连接设置）`;
    const ledgerLine = `🧠 <b>时间线记忆</b>：${ledger.summaries.length} 章总结 · ${ledger.worldStates.length} 条人物/世界状态 · ${openHooksCount} 条待填伏笔`;
    const canonLine = `🗂️ <b>同人补充数据库</b>：已挂载 ${canonDb.items.length} 个设定词条${canonDb.sources.length ? `（${escapeHtml(canonDb.sources.join(', '))}）` : ''}`;

    card.innerHTML = `<div>${novelLine}</div><div>${styleLine}</div><div>${modelLine}</div><div>${ledgerLine}</div><div>${canonLine}</div>`;

    const diffEl = document.getElementById('tt-novel-style-diff');
    if (diffEl) {
        if (sp?.styleCard) {
            const parts = [];
            if (sp.fingerprintText) {
                parts.push(`<b>📊 本地客观指纹：</b><br>${escapeHtml(sp.fingerprintText).replace(/\n/g, '<br>')}`);
            }
            if (sp.diffFindings) {
                parts.push(`<b>🔍 盲测对抗揪出的 AI 味破绽与纠偏：</b><br>${escapeHtml(sp.diffFindings).replace(/\n/g, '<br>')}`);
            }
            diffEl.innerHTML = parts.join('<hr style="margin:6px 0;opacity:0.25;" />') || '已加载手动编辑的文风 DNA 卡。';
        } else {
            diffEl.textContent = '尚未执行文风蒸馏。点击上方「🎨 蒸馏原著文风」按钮，插件会以并发上限 2 自动完成：客观指纹分析 → 双路解剖 → 盲测仿写 → 真迹找茬纠偏。';
        }
    }

    const editorEl = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('tt-novel-style-editor'));
    if (editorEl && document.activeElement !== editorEl) {
        editorEl.value = sp?.styleCard || '';
    }
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
        authorMode: '#tt-novel-chk-author-mode',
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
    mountReaderUi({
        settings,
        onToggleSetting: handleToggleSetting,
        onCutoffFromChapter: handleCutoffFromChapter,
        onViewChapter: handleViewOriginalChapter,
    });
    await restoreNovelFloorsIfNeeded();
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();

    if (settings.remoteBridgeUrl) {
        const updateBridgeUi = ({ state, detail }) => {
            const statusEl = document.getElementById('tt-novel-bridge-status');
            if (!statusEl) return;
            const icon = state === 'connected' ? '🟢' : (state === 'connecting' ? '🟡' : (state === 'error' ? '🔴' : '⚪'));
            statusEl.textContent = `${icon} ${detail || state}`;
        };
        connectRemoteBridge(settings.remoteBridgeUrl, { getSettings, saveExtensionSettings }, updateBridgeUi);
    }

    const { eventSource, eventTypes } = context;
    if (eventSource && eventTypes) {
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        if (eventTypes.MESSAGE_SWIPED) {
            eventSource.on(eventTypes.MESSAGE_SWIPED, onMessageSwiped);
        }
        eventSource.on(eventTypes.CHAT_CHANGED, async () => {
            applyReaderBodyClasses(getSettings());
            await restoreNovelFloorsIfNeeded();
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
