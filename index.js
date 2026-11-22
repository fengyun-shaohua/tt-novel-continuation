import { extension_settings, getContext } from '/scripts/extensions.js';
import { extension_prompt_roles, extension_prompt_types } from '/scripts/extension-prompts.js';
import { oai_settings } from '/scripts/openai.js';
import { getPresetManager } from '/scripts/preset-manager.js';
import { deleteMessage, resetChatSurfaceView } from '/script.js';
import { escapeHtml } from '/scripts/utils.js';
import { buildSurgicalDeclichePrompt, scanStoryCliches } from './cliche-guard.js';
import {
    buildNovelStateTrailerPrompt,
    buildSingleCallContinuationContext,
    isContinuedNovelFloor,
    resolveCurrentTargetChapterIndex,
} from './context-assembler.js';
import { extractNovelStateBlock, parseNovelTxt, parseSupplementaryDatabase, stripNonStoryBlocks } from './parser.js';
import { generateDirectorOutline, resolveLatestChapterAnchor } from './outline-director.js';
import {
    applyReaderBodyClasses,
    clearReadingProgress,
    closeWorkbench,
    mountReaderUi,
    openWorkbench,
    refreshReaderWidgets,
    scrollToChatFloor,
    updateBridgeStatusUi,
    updateLiveProgress,
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
    mergeArchivedDataIntoLedger,
    pruneLedgerAfterChapter,
    saveCanonDb,
    saveLedger,
    saveNovelData,
    syncWorldUpdatesToTavernLorebook,
} from './storage.js';
import {
    rerunArchiveBatches,
    runStoryAndCharacterArchivePipeline,
    synthesizeArchiveFromBatches,
} from './story-archiver.js';
import {
    buildDistillationPresetMessages,
    compressAndDeoverfitStyleCard,
    runStyleDistillationPipeline,
} from './style-distiller.js';

const SETTINGS_KEY = 'novel_continuation';
const EXTENSION_PROMPT_TAG = 'novel_continuation_golden_context';
const EXTENSION_PROMPT_TRAILER_TAG = 'novel_continuation_state_trailer';

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
    distillPresetName: '__current__',
    bgApiMode: 'tavern',
    bgCustomApiUrl: '',
    bgCustomApiKey: '',
    bgCustomApiModel: '',
    bgCustomApiModelsCache: [],
    bgCustomTemperature: 0.7,
    clicheBlacklist: '',
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
 * Assembles the Single-Call Golden Context (`depth = 1`) and the dedicated `<novel_state>` / `<hooks>`
 * trailer (`depth = 0`) in local memory (<5ms, 0 extra API calls).
 */
globalThis.novelContinuation_interceptGeneration = async function (chat, _contextSize, _abort, type) {
    const settings = getSettings();
    const context = getContext();
    if (!settings.enabled || type === 'quiet' || type === 'impersonate') {
        context?.setExtensionPrompt?.(EXTENSION_PROMPT_TAG, '', extension_prompt_types.NONE, 0);
        context?.setExtensionPrompt?.(EXTENSION_PROMPT_TRAILER_TAG, '', extension_prompt_types.NONE, 0);
        return;
    }

    try {
        // Keep the latest `mountAnchorChapters` (default 3, up to 20) original chapters in `coreChat`
        // AND merge consecutive original chapter floors into ONE continuous assistant message so
        // preset processors (e.g. Meowssiah/SPreset) never truncate earlier chapters as foreign archives.
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
        const hasExternalLwbSummary = Boolean(
            context?.extensionPrompts?.LittleWhiteBox_StorySummary?.value
            && String(context.extensionPrompts.LittleWhiteBox_StorySummary.value).trim(),
        );
        const promptBlock = buildSingleCallContinuationContext({
            chat,
            novelData,
            ledger,
            canonDb,
            settings,
            generationType: type || 'normal',
            hasExternalLwbSummary,
        });
        const trailerBlock = buildNovelStateTrailerPrompt({
            chat,
            novelData,
            ledger,
            settings,
            generationType: type || 'normal',
        });

        if (promptBlock) {
            if (settings.authorMode !== false) {
                context?.setExtensionPrompt?.('PERSONA_DESCRIPTION', '', extension_prompt_types.NONE, 0);

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
            if (trailerBlock) {
                context?.setExtensionPrompt?.(
                    EXTENSION_PROMPT_TRAILER_TAG,
                    trailerBlock,
                    extension_prompt_types.IN_CHAT,
                    0,
                    false,
                    extension_prompt_roles.SYSTEM,
                );
            } else {
                context?.setExtensionPrompt?.(EXTENSION_PROMPT_TRAILER_TAG, '', extension_prompt_types.NONE, 0);
            }
        } else {
            context?.setExtensionPrompt?.(EXTENSION_PROMPT_TAG, '', extension_prompt_types.NONE, 0);
            context?.setExtensionPrompt?.(EXTENSION_PROMPT_TRAILER_TAG, '', extension_prompt_types.NONE, 0);
        }
    } catch (error) {
        console.warn('[小说续写阅读器] 组装单次上下文时出错：', error);
    }
};

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
    if (extracted.hasState) {
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
    }

    // 0-API local cliché scan right after generation completes
    const clicheScan = scanStoryCliches(msg.mes, settings.clicheBlacklist);
    msg.extra.novelClicheHits = clicheScan.totalHits;

    await context.saveChat?.();
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();

    if (clicheScan.totalHits > 0) {
        globalThis.toastr?.info?.(
            `第 ${chapterIndex} 章检测到 ${clicheScan.totalHits} 处八股词（${clicheScan.uniqueTerms.slice(0, 3).join('、')}），可在「工作台 → 反八股」一键精修`,
            '小说续写阅读器',
        );
    }

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
    }
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();
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
        // Ignore save errors on welcome screen
    }
    try {
        resetChatSurfaceView?.({ includeAuxiliary: true });
    } catch {
        // Ignore if surface not initialized
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

async function restoreNovelFloorsIfNeeded() {
    const settings = getSettings();
    if (!settings.enabled) return;
    const context = getContext();
    if (!Array.isArray(context?.chat)) return;

    const hasOriginalFloors = context.chat.some(m => m?.extra?.novelContinuationOrigin === 'original');
    if (hasOriginalFloors) return;

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
        `已截断至第 ${targetChapterIndex} 章，现在可直接往下续写！`,
        '小说续写阅读器',
    );
}

/* ==========================================================================
   Shared Model, Preset Resolution & Background LLM Caller (Single Path!)
   ========================================================================== */
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

function getAvailableOpenAiPresetNames() {
    try {
        const pm = getPresetManager('openai');
        const names = pm?.getAllPresets?.();
        return Array.isArray(names) ? names.filter(n => typeof n === 'string' && n.trim()) : [];
    } catch {
        return [];
    }
}

function resolveSelectedDistillationPreset(presetSelection) {
    const selected = String(presetSelection ?? '').trim();
    if (!selected) {
        return { presetObj: null, label: '不使用预设（纯净直连）', isActivePreset: false };
    }

    const pm = getPresetManager('openai');
    const activeName = String(pm?.getSelectedPresetName?.() || oai_settings?.preset_settings_openai || '').trim();
    if (selected === '__current__' || (activeName && selected === activeName)) {
        if (Array.isArray(oai_settings?.prompts) && oai_settings.prompts.length > 0) {
            return {
                presetObj: oai_settings,
                label: activeName ? `当前酒馆预设：${activeName}` : '当前酒馆预设',
                isActivePreset: true,
            };
        }
        if (selected === '__current__') {
            return { presetObj: null, label: '不使用预设（当前非对话补全预设）', isActivePreset: false };
        }
    }

    let rawPreset = pm?.getCompletionPresetByName?.(selected);
    if (typeof rawPreset === 'string') {
        try {
            rawPreset = JSON.parse(rawPreset);
        } catch {
            rawPreset = null;
        }
    }
    if (!rawPreset || !Array.isArray(rawPreset.prompts)) {
        throw new Error(`未找到所选预设「${selected}」，请在「工作台 → 设置」中重新选择`);
    }
    return { presetObj: rawPreset, label: selected, isActivePreset: false };
}

function normalizeCustomApiBaseUrl(rawUrl) {
    return String(rawUrl || '')
        .trim()
        .replace(/\/chat\/completions\/?$/i, '')
        .replace(/\/models\/?$/i, '')
        .replace(/\/+$/, '');
}

function extractChatCompletionText(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    if (data.error) {
        const msg = typeof data.error === 'string'
            ? data.error
            : (data.error.message || JSON.stringify(data.error));
        throw new Error(msg);
    }
    const msgContent = data?.choices?.[0]?.message?.content;
    if (typeof msgContent === 'string') return msgContent;
    if (Array.isArray(msgContent)) {
        return msgContent.map(part => (typeof part === 'string' ? part : (part?.text || ''))).join('');
    }
    if (typeof data?.choices?.[0]?.text === 'string') return data.choices[0].text;
    if (Array.isArray(data?.content)) {
        return data.content.map(part => part?.text || '').join('');
    }
    if (typeof data?.content === 'string') return data.content;
    return '';
}

async function callCustomOpenAiViaHost({ baseUrl, apiKey, model, temperature, messages }) {
    const context = getContext();
    const headers = typeof context?.getRequestHeaders === 'function'
        ? { ...context.getRequestHeaders(), 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: '',
            reverse_proxy: baseUrl,
            proxy_password: apiKey,
            model,
            messages,
            temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.7,
            max_tokens: 8192,
            stream: false,
            type: 'quiet',
        }),
    });

    const rawText = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        // Non-JSON error body
    }
    if (!response.ok) {
        const errMsg = parsed?.error?.message || parsed?.message || rawText.slice(0, 240) || `HTTP ${response.status}`;
        throw new Error(`自定义 API 请求失败 (${response.status})：${errMsg}`);
    }
    return extractChatCompletionText(parsed ?? rawText);
}

async function fetchCustomApiModels() {
    const settings = getSettings();
    const baseUrl = normalizeCustomApiBaseUrl(settings.bgCustomApiUrl);
    if (!baseUrl) {
        globalThis.toastr?.warning?.('请先填写自定义 API 的 Base URL（例如 https://api.xxx.com/v1）', '小说续写阅读器');
        return [];
    }
    const apiKey = String(settings.bgCustomApiKey || '').trim();
    const context = getContext();
    const headers = typeof context?.getRequestHeaders === 'function'
        ? { ...context.getRequestHeaders(), 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' };

    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: '',
            reverse_proxy: baseUrl,
            proxy_password: apiKey,
            bypass_status_check: false,
        }),
    });
    const result = await response.json();
    if (result?.error) {
        throw new Error(String(result.message || '连接自定义 API 失败'));
    }
    const rawList = Array.isArray(result?.data)
        ? result.data
        : (Array.isArray(result?.data?.data) ? result.data.data : []);
    const modelIds = [...new Set(rawList.map(m => String(m?.id || m?.name || m || '').trim()).filter(Boolean))];
    settings.bgCustomApiModelsCache = modelIds;
    if (!settings.bgCustomApiModel && modelIds.length > 0) {
        settings.bgCustomApiModel = modelIds[0];
    }
    saveExtensionSettings();
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();
    return modelIds;
}

/**
 * Unified preset-wrapped LLM caller shared by:
 * 1) Story & Character Archiver (`story-archiver.js` — full, incremental, single-slice retry, re-synth)
 * 2) Multi-round Style Distiller (`style-distiller.js`)
 * 3) Surgical De-Cliché Refiner (`cliche-guard.js`)
 * Supports BOTH Tavern's current active API (`bgApiMode: 'tavern'`) and Custom OpenAI-compatible API (`bgApiMode: 'custom'`).
 */
function createPresetModelCaller() {
    const context = getContext();
    const settings = getSettings();
    const resolvedPreset = resolveSelectedDistillationPreset(settings.distillPresetName);
    const apiMode = settings.bgApiMode === 'custom' ? 'custom' : 'tavern';

    const substituteFn = typeof context?.substituteParams === 'function'
        ? (text) => context.substituteParams(text)
        : null;

    const preserveDirectives = Boolean(resolvedPreset.isActivePreset);

    if (apiMode === 'custom') {
        const baseUrl = normalizeCustomApiBaseUrl(settings.bgCustomApiUrl);
        const apiKey = String(settings.bgCustomApiKey || '').trim();
        const model = String(settings.bgCustomApiModel || '').trim();
        if (!baseUrl) {
            throw new Error('当前已选择「自定义 API」，请先在「工作台 → 设置」填写 Base URL');
        }
        if (!model) {
            throw new Error('当前已选择「自定义 API」，请先在「工作台 → 设置」选择或填写模型名称');
        }
        const callModel = async ({ prompt, systemPrompt }) => {
            const messages = resolvedPreset.presetObj
                ? buildDistillationPresetMessages(resolvedPreset.presetObj, {
                    systemPrompt,
                    userPrompt: prompt,
                    substitute: substituteFn,
                    preserveDirectives,
                })
                : [
                    ...(systemPrompt ? [{ role: 'system', content: String(systemPrompt).trim() }] : []),
                    { role: 'user', content: String(prompt || '').trim() },
                ];
            const reply = await callCustomOpenAiViaHost({
                baseUrl,
                apiKey,
                model,
                temperature: settings.bgCustomTemperature,
                messages,
            });
            return String(reply || '');
        };
        return {
            callModel,
            modelLabel: `自定义API / ${model}`,
            presetLabel: resolvedPreset.label,
        };
    }

    if (typeof context?.generateRaw !== 'function') {
        throw new Error('当前环境不支持 generateRaw 模型调用');
    }
    const modelLabel = getActiveApiModelLabel();

    const callModel = async ({ prompt, systemPrompt }) => {
        if (resolvedPreset.presetObj) {
            const messages = buildDistillationPresetMessages(resolvedPreset.presetObj, {
                systemPrompt,
                userPrompt: prompt,
                substitute: substituteFn,
                preserveDirectives,
            });
            const reply = await context.generateRaw({ prompt: messages });
            return String(reply || '');
        }
        const reply = await context.generateRaw({ prompt, systemPrompt });
        return String(reply || '');
    };

    return {
        callModel,
        modelLabel: `酒馆API / ${modelLabel}`,
        presetLabel: resolvedPreset.label,
    };
}

function getRuntimeMeta() {
    const settings = getSettings();
    let presetLabel = '不使用预设（纯净直连）';
    try {
        presetLabel = resolveSelectedDistillationPreset(settings.distillPresetName).label;
    } catch {
        presetLabel = `${settings.distillPresetName}（未找到）`;
    }
    const activePresetName = String(
        getPresetManager('openai')?.getSelectedPresetName?.() || oai_settings?.preset_settings_openai || '',
    ).trim();
    const isCustom = settings.bgApiMode === 'custom';
    const bgModelLabel = isCustom
        ? `自定义API / ${settings.bgCustomApiModel || '未填模型'}`
        : `酒馆API / ${getActiveApiModelLabel()}`;
    return {
        activeModel: bgModelLabel,
        tavernModel: getActiveApiModelLabel(),
        bgApiMode: isCustom ? 'custom' : 'tavern',
        presetLabel,
        activePresetName,
        presetNames: getAvailableOpenAiPresetNames(),
    };
}

function collectContinuedChaptersFromChat(novelData) {
    const chat = getContext()?.chat || [];
    let lastOrigIdx = -1;
    chat.forEach((m, idx) => {
        if (m?.extra?.novelContinuationOrigin === 'original') lastOrigIdx = idx;
    });
    const cutoff = Number(novelData?.cutoffChapterIndex || 0);
    const list = [];
    let seq = 0;
    chat.forEach((m, idx) => {
        if (!isContinuedNovelFloor(m, idx, lastOrigIdx)) return;
        seq += 1;
        const chIdx = Number(m.extra?.novelChapterIndex) || (cutoff + seq);
        const cleanBody = stripNonStoryBlocks(m.mes || '').replace(/<\/?game>/gi, '').trim();
        if (!cleanBody) return;
        const firstLine = cleanBody.split('\n').map(l => l.trim()).find(Boolean) || `续写第 ${chIdx} 章`;
        list.push({
            index: chIdx,
            title: firstLine.replace(/^#+\s*/, '').slice(0, 40),
            content: cleanBody,
        });
    });
    return list;
}

function getLatestClicheStatus() {
    const chat = getContext()?.chat || [];
    let lastOrigIdx = -1;
    chat.forEach((m, idx) => {
        if (m?.extra?.novelContinuationOrigin === 'original') lastOrigIdx = idx;
    });
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (isContinuedNovelFloor(chat[i], i, lastOrigIdx)) {
            const msg = chat[i];
            const report = scanStoryCliches(msg.mes || '', getSettings().clicheBlacklist);
            return {
                hasContinuedFloor: true,
                floorIndex: i,
                chapterIndex: Number(msg.extra?.novelChapterIndex) || i,
                report,
            };
        }
    }
    return { hasContinuedFloor: false, floorIndex: -1, chapterIndex: 0, report: null };
}

/* ==========================================================================
   Background Tasks: Archive / Style Distillation / Surgical De-Cliché
   ========================================================================== */
async function runStoryArchiveTask(mode = 'full') {
    const novelData = await loadNovelData();
    const continuedChapters = collectContinuedChaptersFromChat(novelData);
    if (!novelData?.chapters?.length && continuedChapters.length === 0) {
        globalThis.toastr?.warning?.('请先导入原著小说 TXT/MD 文件', '小说续写阅读器');
        return;
    }

    let caller;
    try {
        caller = createPresetModelCaller();
    } catch (err) {
        globalThis.toastr?.warning?.(err?.message || String(err), '小说续写阅读器');
        return;
    }

    const existingLedger = await loadLedger();
    updateLiveProgress('memory', {
        isRunning: true,
        isError: false,
        resetLogs: true,
        text: `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 启动${mode === 'incremental' ? '增量' : '全本'}剧情与 4 维人物归档（并发上限 ≤ 2）...`,
    });

    try {
        const result = await runStoryAndCharacterArchivePipeline({
            novelData: novelData || { title: '当前小说', cutoffChapterIndex: 0, totalChapters: 0, chapters: [] },
            continuedChapters,
            existingLedger,
            mode,
            maxConcurrency: 2,
            callModel: caller.callModel,
            onProgress: ({ step, totalSteps, label, logEntry }) => {
                updateLiveProgress('memory', {
                    isRunning: true,
                    text: `⏳ [${caller.modelLabel}] [${step}/${totalSteps}] ${label}`,
                    logEntry,
                });
            },
        });

        await mergeArchivedDataIntoLedger(result, { mode });
        const warnTail = result.failedBatchCount > 0
            ? ` ⚠️ 其中有 ${result.failedBatchCount} 个切片疑似道歉/失败，请在下方「分批切片管理」中单独重跑后点「重新合稿」！`
            : ' 全部切片均正常提取，续写自动生效！';
        updateLiveProgress('memory', {
            isRunning: false,
            text: `✅ 归档完成（至第 ${result.lastArchivedChapter} 章 · ${result.chronicle.length} 条编年史 · ${result.characters.length} 位人物灵魂卡 · ${result.hooks.length} 条伏笔）。${warnTail}`,
        });
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
        globalThis.toastr?.success?.(
            `已提炼 ${result.chronicle.length} 条剧情编年史、${result.characters.length} 位人物档案与 ${result.hooks.length} 条伏笔${result.failedBatchCount > 0 ? `（${result.failedBatchCount} 片需单独重跑）` : ''}！`,
            '小说续写阅读器',
        );
    } catch (error) {
        updateLiveProgress('memory', {
            isRunning: false,
            isError: true,
            text: `❌ 归档失败：${error?.message || error}`,
        });
        globalThis.toastr?.error?.(`归档失败：${error?.message || error}`, '小说续写阅读器');
    }
}

async function runRerunArchiveBatchesTask(targetBatchIndices) {
    const novelData = await loadNovelData();
    const continuedChapters = collectContinuedChaptersFromChat(novelData);
    const ledger = await loadLedger();
    const indices = Array.isArray(targetBatchIndices) ? targetBatchIndices : [Number(targetBatchIndices)];
    const validIndices = indices.filter(n => Number.isFinite(n) && n > 0);
    if (validIndices.length === 0 || !ledger.archiveBatches?.length) {
        globalThis.toastr?.warning?.('没有可重跑的切片记录', '小说续写阅读器');
        return;
    }

    let caller;
    try {
        caller = createPresetModelCaller();
    } catch (err) {
        globalThis.toastr?.warning?.(err?.message || String(err), '小说续写阅读器');
        return;
    }

    updateLiveProgress('memory', {
        isRunning: true,
        isError: false,
        text: `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 重跑 ${validIndices.length} 个切片（#${validIndices.join(', #')}）...`,
    });

    try {
        const { batches, refreshed } = await rerunArchiveBatches({
            novelData: novelData || { title: '当前小说', cutoffChapterIndex: 0, totalChapters: 0, chapters: [] },
            continuedChapters,
            existingBatches: ledger.archiveBatches,
            targetBatchIndices: validIndices,
            maxConcurrency: 2,
            callModel: caller.callModel,
            onProgress: ({ step, totalSteps, label }) => {
                updateLiveProgress('memory', {
                    isRunning: true,
                    text: `⏳ [${caller.modelLabel}] [${step}/${totalSteps}] ${label}`,
                });
            },
        });

        ledger.archiveBatches = batches;
        const okRefreshed = refreshed.filter(b => b.status === 'ok').length;
        if (okRefreshed > 0) {
            ledger.archiveNeedsResynth = true;
        }
        await saveLedger(ledger);
        const stillBad = refreshed.filter(b => b.status !== 'ok').length;
        updateLiveProgress('memory', {
            isRunning: false,
            isError: stillBad > 0 && okRefreshed === 0,
            text: okRefreshed > 0
                ? `✅ 重跑完成：${okRefreshed}/${refreshed.length} 个切片已恢复正常！请点击「🔁 用当前切片重新合稿总账」把补齐的章节合并进编年史与人物卡。`
                : `⚠️ 重跑的 ${refreshed.length} 个切片仍疑似道歉或失败，建议在「⚙️ 设置」中切换自定义 API 或调整预设（例如选「不使用预设（纯净直连）」）后再重跑！`,
        });
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
    } catch (error) {
        updateLiveProgress('memory', {
            isRunning: false,
            isError: true,
            text: `❌ 切片重跑失败：${error?.message || error}`,
        });
        globalThis.toastr?.error?.(`切片重跑失败：${error?.message || error}`, '小说续写阅读器');
    }
}

async function runResynthArchiveTask() {
    const novelData = await loadNovelData();
    const ledger = await loadLedger();
    if (!ledger.archiveBatches?.length) {
        globalThis.toastr?.warning?.('尚无已保存的切片数据，请先执行一次全本通读归档', '小说续写阅读器');
        return;
    }

    let caller;
    try {
        caller = createPresetModelCaller();
    } catch (err) {
        globalThis.toastr?.warning?.(err?.message || String(err), '小说续写阅读器');
        return;
    }

    updateLiveProgress('memory', {
        isRunning: true,
        isError: false,
        text: `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 复用现有正常切片重新合稿总账（不重读原文）...`,
    });

    try {
        const synth = await synthesizeArchiveFromBatches({
            novelTitle: novelData?.title || '当前小说',
            batches: ledger.archiveBatches,
            existingLedger: ledger,
            mode: 'full',
            maxConcurrency: 2,
            callModel: caller.callModel,
            onProgress: ({ step, totalSteps, label, logEntry }) => {
                updateLiveProgress('memory', {
                    isRunning: true,
                    text: `⏳ [${caller.modelLabel}] [${step}/${totalSteps}] ${label}`,
                    logEntry,
                });
            },
        });

        await mergeArchivedDataIntoLedger(synth, { mode: 'full' });
        updateLiveProgress('memory', {
            isRunning: false,
            text: `✅ 重新合稿完成：${synth.chronicle.length} 条编年史 · ${synth.characters.length} 位人物灵魂卡 · ${synth.hooks.length} 条伏笔（已复用全部正常切片）！`,
        });
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
        globalThis.toastr?.success?.(
            `重新合稿完成：${synth.chronicle.length} 条编年史 · ${synth.characters.length} 位人物灵魂卡！`,
            '小说续写阅读器',
        );
    } catch (error) {
        updateLiveProgress('memory', {
            isRunning: false,
            isError: true,
            text: `❌ 重新合稿失败：${error?.message || error}`,
        });
        globalThis.toastr?.error?.(`重新合稿失败：${error?.message || error}`, '小说续写阅读器');
    }
}

async function runStyleDistillTask({ incremental = false, evaluateOnly = false } = {}) {
    const novelData = await loadNovelData();
    if (!novelData?.chapters?.length) {
        globalThis.toastr?.warning?.('请先导入原著小说 TXT/MD 文件', '小说续写阅读器');
        return;
    }

    const ledger = await loadLedger();
    if ((incremental || evaluateOnly) && !ledger?.styleProfile?.styleCard) {
        globalThis.toastr?.warning?.('请先执行一次完整文风蒸馏，再进行盲测精炼或纯跑分验收', '小说续写阅读器');
        return;
    }

    let caller;
    try {
        caller = createPresetModelCaller();
    } catch (err) {
        globalThis.toastr?.warning?.(err?.message || String(err), '小说续写阅读器');
        return;
    }

    const rounds = Math.max(1, Math.min(3, Number(getSettings().distillRounds) || 2));
    updateLiveProgress('style', {
        isRunning: true,
        isError: false,
        resetLogs: !(incremental || evaluateOnly),
        text: evaluateOnly
            ? `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 启动纯跑分盲测验收（不修改当前 ${String(ledger.styleProfile.styleCard).length} 字圣经）...`
            : (incremental
                ? `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 追加 1 轮全新真迹盲测与评分...`
                : `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 启动 ${rounds} 轮骨相对抗蒸馏（并发上限 ≤ 2）...`),
    });

    try {
        const styleProfile = await runStyleDistillationPipeline({
            novelData,
            maxConcurrency: 2,
            rounds,
            existingProfile: (incremental || evaluateOnly) ? ledger.styleProfile : null,
            evaluateOnly,
            callModel: caller.callModel,
            onProgress: ({ step, totalSteps, label, logEntry }) => {
                updateLiveProgress('style', {
                    isRunning: true,
                    text: `⏳ [${caller.modelLabel}] [${step}/${totalSteps}] ${label}`,
                    logEntry,
                });
            },
        });

        ledger.styleProfile = styleProfile;
        await saveLedger(ledger);
        const scoreChain = (styleProfile.roundHistory || [])
            .map(r => `${r.evaluateOnly ? '验' : 'R'}${r.round} ${r.score !== null ? `${r.score}分` : '?'}`)
            .join(' → ');
        updateLiveProgress('style', {
            isRunning: false,
            text: evaluateOnly
                ? `✅ 纯跑分验收完成：本轮 ${styleProfile.latestScore ?? '?'}/100 分（圣经保持 ${String(styleProfile.styleCard).length} 字未改 · 历程 ${scoreChain}），可展开下方卡片查看客观指标与真迹对照！`
                : `✅ 蒸馏完成（${String(styleProfile.styleCard).length} 字 · ${scoreChain || '已定稿'}），全过程已保存，后续每章自动生效！`,
        });
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
        globalThis.toastr?.success?.(
            evaluateOnly
                ? `纯跑分验收完成：${styleProfile.latestScore ?? '?'}/100 分（圣经未改动）！`
                : `原著文风骨相蒸馏完成（${scoreChain || '已定稿'}）！`,
            '小说续写阅读器',
        );
    } catch (error) {
        updateLiveProgress('style', {
            isRunning: false,
            isError: true,
            text: `❌ ${evaluateOnly ? '跑分验收' : '蒸馏'}失败：${error?.message || error}`,
        });
        globalThis.toastr?.error?.(`${evaluateOnly ? '跑分验收' : '文风蒸馏'}失败：${error?.message || error}`, '小说续写阅读器');
    }
}

async function runCompressStyleCardTask() {
    const ledger = await loadLedger();
    const sp = ledger?.styleProfile;
    if (!sp?.styleCard || !String(sp.styleCard).trim()) {
        globalThis.toastr?.warning?.('当前还没有已生成的文风圣经可供提纯瘦身', '小说续写阅读器');
        return;
    }

    let caller;
    try {
        caller = createPresetModelCaller();
    } catch (err) {
        globalThis.toastr?.warning?.(err?.message || String(err), '小说续写阅读器');
        return;
    }

    const beforeLen = String(sp.styleCard).length;
    updateLiveProgress('style', {
        isRunning: true,
        isError: false,
        text: `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 将 ${beforeLen} 字文风圣经去过拟合提纯至 ~2,200 字实战版...`,
    });

    try {
        const compressed = await compressAndDeoverfitStyleCard({
            novelTitle: sp.title || '当前小说',
            styleCard: sp.styleCard,
            fingerprintText: sp.fingerprintText || '',
            callModel: caller.callModel,
        });
        sp.styleCard = compressed;
        sp.distilledAt = Date.now();
        sp.processLog = Array.isArray(sp.processLog) ? sp.processLog : [];
        sp.processLog.push({
            id: `compress_${Date.now()}`,
            type: 'stage',
            title: `✨ 去过拟合提纯瘦身（${beforeLen} 字 → ${compressed.length} 字）`,
            summary: `已剥离单章原句剧透与冗余重复，保留全部核心骨相洞察，节省 ${Math.max(0, beforeLen - compressed.length)} 字上下文。`,
            detail: compressed,
        });
        await saveLedger(ledger);
        updateLiveProgress('style', {
            isRunning: false,
            text: `✅ 提纯瘦身完成：${beforeLen} 字 → ${compressed.length} 字！现在可以直接点击上方「🧪 纯跑分盲测验收 (不改圣经)」实测瘦身后的真实得分与真迹对比！`,
        });
        await refreshReaderWidgets();
        await refreshSettingsStatusCard();
        globalThis.toastr?.success?.(`文风圣经已提纯瘦身：${beforeLen} 字 → ${compressed.length} 字！`, '小说续写阅读器');
    } catch (error) {
        updateLiveProgress('style', {
            isRunning: false,
            isError: true,
            text: `❌ 提纯瘦身失败：${error?.message || error}`,
        });
        globalThis.toastr?.error?.(`提纯瘦身失败：${error?.message || error}`, '小说续写阅读器');
    }
}

async function runGenerateDirectorOutlineTask({
    userBrief = '',
    selectedHookIds = [],
    sceneCount = 4,
    chapterCount = 1,
    paceMode = 'slow',
} = {}) {
    const novelData = await loadNovelData();
    const continuedChapters = collectContinuedChaptersFromChat(novelData);
    if (!novelData?.chapters?.length && continuedChapters.length === 0) {
        globalThis.toastr?.warning?.('请先导入原著小说 TXT/MD 文件后再生成导演大纲', '小说续写阅读器');
        return;
    }

    let caller;
    try {
        caller = createPresetModelCaller();
    } catch (err) {
        globalThis.toastr?.warning?.(err?.message || String(err), '小说续写阅读器');
        return;
    }

    const count = Math.max(1, Math.min(8, Number(chapterCount) || 1));
    const ledger = await loadLedger();
    updateLiveProgress('outline', {
        isRunning: true,
        isError: false,
        text: `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 结合最新结尾、人物灵魂卡与所选伏笔策划连续 ${count} 章原味分镜大纲...`,
    });

    try {
        const res = await generateDirectorOutline({
            novelData,
            continuedChapters,
            ledger,
            userBrief,
            selectedHookIds,
            sceneCount,
            chapterCount: count,
            paceMode,
            callModel: caller.callModel,
        });

        ledger.draftOutline = {
            userBrief: String(userBrief || '').trim(),
            outlineText: res.outlineText,
            chapters: res.chapters,
            sceneCount: Number(sceneCount) || 4,
            chapterCount: count,
            paceMode: paceMode || 'slow',
            selectedHookIds: [...(selectedHookIds || [])],
            targetChapterIndex: res.targetChapterIndex,
            updatedAt: res.generatedAt,
        };
        await saveLedger(ledger);
        const rangeLabel = res.chapters.length > 1
            ? `第 ${res.targetChapterIndex}~${res.endChapterIndex} 章（共 ${res.chapters.length} 章分镜队列）`
            : `第 ${res.targetChapterIndex} 章`;
        updateLiveProgress('outline', {
            isRunning: false,
            text: `✅ ${rangeLabel}原味导演大纲已生成！可逐章微调后直接点「📋 填入此章」或「🚀 续写此章」。`,
        });
        await refreshReaderWidgets();
        globalThis.toastr?.success?.(`${rangeLabel}原味导演大纲已就绪！`, '小说续写阅读器');
    } catch (error) {
        updateLiveProgress('outline', {
            isRunning: false,
            isError: true,
            text: `❌ 生成大纲失败：${error?.message || error}`,
        });
        globalThis.toastr?.error?.(`生成导演大纲失败：${error?.message || error}`, '小说续写阅读器');
    }
}

function applyDirectorOutlineToChatInput(outlineText, { autoSend = false } = {}) {
    const text = String(outlineText || '').trim();
    if (!text) {
        globalThis.toastr?.warning?.('当前大纲内容为空，请先生成或输入大纲', '小说续写阅读器');
        return;
    }
    const textarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('send_textarea'));
    if (!textarea) {
        globalThis.toastr?.error?.('未找到聊天输入框 #send_textarea', '小说续写阅读器');
        return;
    }
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    closeWorkbench();
    textarea.focus();

    if (autoSend) {
        requestAnimationFrame(() => {
            const sendBtn = document.getElementById('send_but');
            if (sendBtn && !sendBtn.classList.contains('displayNone')) {
                sendBtn.click();
            } else {
                globalThis.toastr?.info?.('大纲已填入底部输入框，请点击发送按钮开始续写！', '小说续写阅读器');
            }
        });
    } else {
        globalThis.toastr?.success?.('原味导演大纲已填入底部聊天输入框，确认无误后直接点发送即可续写！', '小说续写阅读器');
    }
}

async function getLatestChapterAnchorInfo() {
    const novelData = await loadNovelData();
    const continuedChapters = collectContinuedChaptersFromChat(novelData);
    return resolveLatestChapterAnchor(novelData, continuedChapters);
}

async function runSurgicalDeclicheLatestTask() {
    const status = getLatestClicheStatus();
    if (!status.hasContinuedFloor) {
        globalThis.toastr?.warning?.('当前还没有 AI 续写章节可供精修', '小说续写阅读器');
        return;
    }

    let caller;
    try {
        caller = createPresetModelCaller();
    } catch (err) {
        globalThis.toastr?.warning?.(err?.message || String(err), '小说续写阅读器');
        return;
    }

    const context = getContext();
    const msg = context?.chat?.[status.floorIndex];
    if (!msg) return;

    const ledger = await loadLedger();
    const rawOriginal = String(msg.mes || '');
    const hadGameWrapper = /<game>[\s\S]*<\/game>/i.test(rawOriginal);
    const storyOnly = stripNonStoryBlocks(rawOriginal).replace(/<\/?game>/gi, '').trim();

    updateLiveProgress('cliche', {
        isRunning: true,
        isError: false,
        text: `⏳ 使用 [${caller.modelLabel}] · 预设 [${caller.presetLabel}] 对第 ${status.chapterIndex} 章执行局部去八股精修（原稿将自动保留为上一个分支）...`,
    });

    try {
        const { systemPrompt, prompt } = buildSurgicalDeclichePrompt({
            storyText: storyOnly,
            scanReport: status.report,
            styleProfile: ledger.styleProfile,
            customBlacklistText: getSettings().clicheBlacklist,
        });
        const refinedRaw = await caller.callModel({ systemPrompt, prompt });
        const refinedClean = stripNonStoryBlocks(refinedRaw).replace(/<\/?game>/gi, '').trim();
        if (!refinedClean || refinedClean.length < Math.min(120, Math.floor(storyOnly.length * 0.3))) {
            throw new Error('精修返回正文异常过短，已保留原稿未覆盖');
        }

        const finalMes = hadGameWrapper ? `<game>\n${refinedClean}\n</game>` : refinedClean;
        if (!Array.isArray(msg.swipes) || msg.swipes.length === 0) {
            msg.swipes = [rawOriginal];
        }
        msg.swipes.push(finalMes);
        msg.swipe_id = msg.swipes.length - 1;
        msg.mes = finalMes;

        const afterScan = scanStoryCliches(finalMes, getSettings().clicheBlacklist);
        msg.extra = msg.extra || {};
        msg.extra.novelClicheHits = afterScan.totalHits;

        context.updateMessageBlock?.(status.floorIndex, msg);
        await context.saveChat?.();
        updateLiveProgress('cliche', {
            isRunning: false,
            text: `✅ 精修完成！八股命中数由 ${status.report?.totalHits ?? 0} 处降至 ${afterScan.totalHits} 处（原稿已自动保留在上一条 Swipe 分支，可随时左右切换）。`,
        });
        await refreshReaderWidgets();
        globalThis.toastr?.success?.(
            `局部去八股完成：${status.report?.totalHits ?? 0} → ${afterScan.totalHits} 处！`,
            '小说续写阅读器',
        );
    } catch (error) {
        updateLiveProgress('cliche', {
            isRunning: false,
            isError: true,
            text: `❌ 精修失败：${error?.message || error}`,
        });
        globalThis.toastr?.error?.(`局部去八股精修失败：${error?.message || error}`, '小说续写阅读器');
    }
}

/* ==========================================================================
   Import & Settings Handlers
   ========================================================================== */
async function handleImportNovelFile(file) {
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
    }
}

async function handleImportCanonFiles(files) {
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
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();
    globalThis.toastr?.success?.(`已挂载 ${addedCount} 条同人补充原作设定词条！`, '小说续写阅读器');
}

function handleUpdateSetting(key, value) {
    const settings = getSettings();
    settings[key] = value;
    saveExtensionSettings();
    if (key === 'enabled' && !settings.enabled) {
        getContext()?.setExtensionPrompt?.(EXTENSION_PROMPT_TAG, '', extension_prompt_types.NONE, 0);
        getContext()?.setExtensionPrompt?.(EXTENSION_PROMPT_TRAILER_TAG, '', extension_prompt_types.NONE, 0);
    }
    applyReaderBodyClasses(settings);
    const masterChk = document.getElementById('tt-novel-chk-enabled-entry');
    if (masterChk && key === 'enabled') masterChk.checked = Boolean(value);
    void refreshSettingsStatusCard();
}

function handleToggleSetting(key) {
    const settings = getSettings();
    handleUpdateSetting(key, !settings[key]);
}

/* ==========================================================================
   Ultra-Compact Tavern Extension Settings Drawer Entry Card
   ========================================================================== */
function mountSettingsPanel() {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container || document.getElementById('tt_novel_continuation_panel')) return;

    const settings = getSettings();
    const wrapper = document.createElement('div');
    wrapper.id = 'tt_novel_continuation_panel';
    wrapper.className = 'inline-drawer';
    wrapper.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>📖 小说续写阅读器 (v1.3 工作台)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content tt-novel-settings-body">
            <div id="tt-novel-status-card" class="tt-novel-status-card">正在读取当前对话状态...</div>
            <div class="tt-novel-action-bar">
                <button type="button" id="tt-novel-open-workbench" class="menu_button tt-novel-btn-primary">
                    ✨ 打开小说续写工作台（剧情/人物/文风/八股/设置）
                </button>
                <label class="menu_button tt-novel-file-label">
                    <i class="fa-solid fa-file-import"></i> 快速导入原著
                    <input type="file" id="tt-novel-quick-import" accept=".txt,.md,text/plain,text/markdown,*/*" hidden />
                </label>
            </div>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-novel-chk-enabled-entry" ${settings.enabled ? 'checked' : ''} />
                <span>启用小说续写插件（关闭时彻底还原普通酒馆聊天）</span>
            </label>
        </div>
    `;

    container.appendChild(wrapper);

    wrapper.querySelector('#tt-novel-open-workbench')?.addEventListener('click', () => {
        void openWorkbench('memory');
    });
    wrapper.querySelector('#tt-novel-quick-import')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (file) await handleImportNovelFile(file);
        e.target.value = '';
    });
    wrapper.querySelector('#tt-novel-chk-enabled-entry')?.addEventListener('change', (e) => {
        handleUpdateSetting('enabled', Boolean(e.target.checked));
    });

    void refreshSettingsStatusCard();
}

async function refreshSettingsStatusCard() {
    const card = document.getElementById('tt-novel-status-card');
    if (!card) return;

    const [novelData, ledger, canonDb] = await Promise.all([loadNovelData(), loadLedger(), loadCanonDb()]);
    const meta = getRuntimeMeta();
    const openHooksCount = (ledger?.hooks || []).filter(h => h.status !== 'resolved').length;
    const sp = ledger?.styleProfile;
    const novelLine = novelData
        ? `📚 <b>原著</b>：《${escapeHtml(novelData.title)}》（${novelData.totalChapters}章 · 锚点 #${novelData.cutoffChapterIndex}）`
        : '📚 <b>原著</b>：尚未导入';
    const scoreChain = Array.isArray(sp?.roundHistory) && sp.roundHistory.length > 0
        ? ` · ${sp.roundHistory.map(r => `R${r.round} ${r.score ?? '?'}分`).join('→')}`
        : '';
    const styleLine = sp?.styleCard
        ? `🎨 <b>文风骨相</b>：${String(sp.styleCard).length}字${escapeHtml(scoreChain)}`
        : '🎨 <b>文风骨相</b>：未蒸馏';
    const memLine = `🧠 <b>归档记忆</b>：${ledger.characters.length}人物 · ${ledger.chronicle.length}编年史 · ${openHooksCount}待填伏笔 · ${canonDb.items.length}补充设定`;
    const presetLine = `🎛️ <b>模型/预设</b>：<code>${escapeHtml(meta.activeModel)}</code> · <code>${escapeHtml(meta.presetLabel)}</code>`;

    card.innerHTML = `<div>${novelLine}</div><div>${styleLine}</div><div>${memLine}</div><div>${presetLine}</div>`;
}

let initialized = false;

export async function init() {
    if (initialized) return;
    initialized = true;

    const context = getContext();
    const settings = getSettings();

    mountSettingsPanel();
    mountReaderUi({
        getSettings,
        onUpdateSetting: handleUpdateSetting,
        onToggleSetting: handleToggleSetting,
        onCutoffFromChapter: handleCutoffFromChapter,
        onViewChapter: handleViewOriginalChapter,
        onImportNovelFile: handleImportNovelFile,
        onImportCanonFiles: handleImportCanonFiles,
        onClearCanon: async () => {
            await saveCanonDb(createEmptyCanonDb());
            await refreshReaderWidgets();
            await refreshSettingsStatusCard();
            globalThis.toastr?.info?.('已清空当前对话的同人补充设定库', '小说续写阅读器');
        },
        onClearAll: async () => {
            if (!window.confirm('确定清空当前对话导入的原著、编年史、人物灵魂档案、文风与伏笔记录吗？')) return;
            await clearNovelData();
            await saveLedger(createEmptyLedger());
            await saveCanonDb(createEmptyCanonDb());
            clearReadingProgress();
            await refreshReaderWidgets();
            await refreshSettingsStatusCard();
        },
        onRunArchive: runStoryArchiveTask,
        onRerunArchiveBatch: (batchIndex) => runRerunArchiveBatchesTask([batchIndex]),
        onRerunFailedArchiveBatches: async () => {
            const cur = await loadLedger();
            const bad = (cur.archiveBatches || []).filter(b => b.status !== 'ok').map(b => b.batchIndex);
            if (bad.length === 0) {
                globalThis.toastr?.info?.('当前所有切片均已正常，无需重跑', '小说续写阅读器');
                return;
            }
            await runRerunArchiveBatchesTask(bad);
        },
        onResynthArchive: runResynthArchiveTask,
        onFetchCustomModels: fetchCustomApiModels,
        onRunStyleDistill: runStyleDistillTask,
        onCompressStyleCard: runCompressStyleCardTask,
        onGenerateDirectorOutline: runGenerateDirectorOutlineTask,
        onApplyOutlineToChat: applyDirectorOutlineToChatInput,
        getLatestChapterAnchorInfo,
        onRunDeclicheLatest: runSurgicalDeclicheLatestTask,
        onConnectBridge: (url) => {
            settings.remoteBridgeUrl = url;
            saveExtensionSettings();
            connectRemoteBridge(url, { getSettings, saveExtensionSettings }, updateBridgeStatusUi);
        },
        onDisconnectBridge: () => {
            disconnectRemoteBridge();
        },
        getRuntimeMeta,
        getLatestClicheStatus,
    });

    await restoreNovelFloorsIfNeeded();
    await refreshReaderWidgets();
    await refreshSettingsStatusCard();

    if (settings.remoteBridgeUrl) {
        connectRemoteBridge(settings.remoteBridgeUrl, { getSettings, saveExtensionSettings }, updateBridgeStatusUi);
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
