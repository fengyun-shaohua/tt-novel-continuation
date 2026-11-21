import { getContext } from '/scripts/extensions.js';
import {
    applyReaderBodyClasses,
    refreshReaderWidgets,
    scrollToChatFloor,
} from './reader-ui.js';
import {
    loadCanonDb,
    loadLedger,
    loadNovelData,
    saveLedger,
    saveNovelData,
} from './storage.js';

let activeSocket = null;
let reconnectTimer = null;
let manualDisconnect = false;
let currentBridgeUrl = '';
let statusCallback = null;

const HOT_STYLE_ID = 'tt-novel-remote-hot-css';

/**
 * Redacts sensitive attributes or password values before sending DOM snapshots to external Agent.
 * @param {Element} el
 * @returns {boolean}
 */
function isSensitiveElement(el) {
    if (!(el instanceof Element)) return false;
    if (el.matches('input[type="password"], [data-tt-sensitive], [data-private]')) return true;
    const idOrName = `${el.id || ''} ${el.getAttribute('name') || ''}`.toLowerCase();
    return /api[_-]?key|secret|password|token|credential/.test(idOrName);
}

/**
 * Builds a compact semantic DOM & computed-style snapshot for external Agent inspection.
 */
function buildDomSnapshot({ selector = '#chat', maxDepth = 4, includeStyles = true, maxTextLength = 240 } = {}) {
    const roots = [...document.querySelectorAll(selector)].slice(0, 15);
    if (roots.length === 0) {
        return { found: false, selector, matches: [] };
    }

    function serializeNode(el, depth) {
        if (!(el instanceof Element)) return null;
        if (isSensitiveElement(el)) {
            return { tag: el.tagName.toLowerCase(), redacted: true };
        }

        const rect = el.getBoundingClientRect();
        const node = {
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            className: typeof el.className === 'string' && el.className.trim() ? el.className.trim() : undefined,
            attrs: {},
            rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
            },
        };

        for (const attrName of ['mesid', 'is_user', 'is_system', 'title', 'data-i18n', 'open', 'hidden']) {
            if (el.hasAttribute(attrName)) {
                node.attrs[attrName] = el.getAttribute(attrName);
            }
        }
        if (Object.keys(node.attrs).length === 0) delete node.attrs;

        if (includeStyles) {
            const cs = window.getComputedStyle(el);
            node.style = {
                display: cs.display,
                visibility: cs.visibility,
                opacity: cs.opacity,
                position: cs.position,
                color: cs.color,
                backgroundColor: cs.backgroundColor,
                fontSize: cs.fontSize,
                padding: cs.padding,
                margin: cs.margin,
                borderBottom: cs.borderBottom !== '0px none rgb(0, 0, 0)' ? cs.borderBottom : undefined,
            };
        }

        const directText = [...el.childNodes]
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => String(n.textContent || '').trim())
            .filter(Boolean)
            .join(' ');

        if (directText) {
            node.text = directText.length > maxTextLength
                ? `${directText.slice(0, maxTextLength)}…`
                : directText;
        }

        if (depth < maxDepth && el.children.length > 0) {
            node.children = [...el.children]
                .slice(0, 25)
                .map(child => serializeNode(child, depth + 1))
                .filter(Boolean);
        } else if (el.children.length > 0) {
            node.childCount = el.children.length;
        }

        return node;
    }

    return {
        found: true,
        selector,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        matches: roots.map(r => serializeNode(r, 0)),
    };
}

/**
 * Executes a tool call sent by the external Agent over the WebSocket bridge.
 * @param {string} tool
 * @param {Record<string, any>} args
 * @param {{ getSettings: () => any, saveExtensionSettings: () => void }} hooks
 */
async function executeRemoteTool(tool, args = {}, hooks) {
    const context = getContext();

    switch (tool) {
        case 'tt_get_status': {
            const [novelData, ledger, canonDb] = await Promise.all([
                loadNovelData(),
                loadLedger(),
                loadCanonDb(),
            ]);
            return {
                connected: true,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                bodyClasses: [...document.body.classList],
                characterName: context?.name2 || null,
                chatId: context?.getCurrentChatId?.() || context?.chatId || null,
                chatFloorCount: Array.isArray(context?.chat) ? context.chat.length : 0,
                settings: hooks.getSettings(),
                novel: novelData
                    ? {
                        title: novelData.title,
                        totalChapters: novelData.totalChapters,
                        cutoffChapterIndex: novelData.cutoffChapterIndex,
                    }
                    : null,
                ledgerSummary: {
                    summariesCount: ledger.summaries.length,
                    worldStatesCount: ledger.worldStates.length,
                    openHooks: ledger.hooks.filter(h => h.status !== 'resolved'),
                },
                canonDbCount: canonDb.items.length,
            };
        }

        case 'tt_dom_snapshot': {
            return buildDomSnapshot(args);
        }

        case 'tt_hot_css': {
            const cssText = String(args.css ?? '');
            const mode = args.mode === 'append' ? 'append' : 'replace';
            let styleEl = document.getElementById(HOT_STYLE_ID);
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = HOT_STYLE_ID;
                document.head.appendChild(styleEl);
            }
            styleEl.textContent = mode === 'append' ? `${styleEl.textContent}\n${cssText}` : cssText;
            return { ok: true, length: styleEl.textContent.length };
        }

        case 'tt_interact': {
            const { action, selector, value } = args;
            if (action === 'scroll_floor') {
                scrollToChatFloor(Number(value) || 0);
                return { ok: true, action, floor: Number(value) || 0 };
            }
            const el = document.querySelector(selector);
            if (!el) throw new Error(`未找到选择器对应的元素: ${selector}`);
            if (isSensitiveElement(el)) throw new Error(`拒绝操作敏感元素: ${selector}`);

            if (action === 'click') {
                /** @type {HTMLElement} */ (el).click();
            } else if (action === 'fill' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
                el.value = String(value ?? '');
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (action === 'check' && el instanceof HTMLInputElement) {
                el.checked = Boolean(value);
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                throw new Error(`不支持的交互动作: ${action}`);
            }
            return { ok: true, action, selector };
        }

        case 'tt_novel_data': {
            const { action, payload } = args;
            if (action === 'get_ledger') {
                return await loadLedger();
            }
            if (action === 'set_ledger' && payload) {
                await saveLedger(payload);
                await refreshReaderWidgets();
                return { ok: true };
            }
            if (action === 'update_settings' && payload && typeof payload === 'object') {
                const settings = hooks.getSettings();
                Object.assign(settings, payload);
                hooks.saveExtensionSettings();
                applyReaderBodyClasses(settings);
                await refreshReaderWidgets();
                return { ok: true, settings };
            }
            if (action === 'get_chat_messages') {
                const chat = context?.chat || [];
                const limit = Math.min(20, Math.max(1, Number(payload?.limit) || 5));
                return chat.slice(-limit).map((m, idx) => ({
                    floorIndex: chat.length - limit + idx,
                    is_user: Boolean(m.is_user),
                    name: m.name,
                    mesPreview: String(m.mes || '').slice(0, 600),
                    reasoningPreview: String(m.extra?.reasoning || '').slice(0, 200),
                    extra: m.extra,
                }));
            }
            if (action === 'set_cutoff' && Number.isFinite(Number(payload?.cutoffChapterIndex))) {
                const novelData = await loadNovelData();
                if (!novelData) throw new Error('当前未导入原著小说');
                novelData.cutoffChapterIndex = Number(payload.cutoffChapterIndex);
                await saveNovelData(novelData);
                await refreshReaderWidgets();
                return { ok: true, cutoffChapterIndex: novelData.cutoffChapterIndex };
            }
            throw new Error(`未知的数据操作: ${action}`);
        }

        case 'tt_evaluate': {
            const code = String(args.code || '').trim();
            if (!code) throw new Error('code 不能为空');
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            const fn = new AsyncFunction('context', 'api', 'document', 'window', code);
            const result = await fn(context, globalThis.__TAURITAVERN__?.api, document, window);
            return { result: result ?? null };
        }

        default:
            throw new Error(`未知的远程工具: ${tool}`);
    }
}

function notifyStatus(state, detail = '') {
    statusCallback?.({ state, detail, url: currentBridgeUrl });
}

/**
 * Connects the phone/client TauriTavern instance to the computer's MCP/WebSocket bridge server.
 */
export function connectRemoteBridge(wsUrl, hooks, onStatusChange) {
    if (onStatusChange) statusCallback = onStatusChange;
    const url = String(wsUrl || '').trim();
    if (!url || !/^wss?:\/\//i.test(url)) {
        notifyStatus('error', '请输入合法的 ws://电脑局域网IP:17890/ws 地址');
        return;
    }

    manualDisconnect = false;
    currentBridgeUrl = url;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (activeSocket) {
        try {
            activeSocket.close();
        } catch {
            // Ignore close errors
        }
        activeSocket = null;
    }

    notifyStatus('connecting', `正在连接 ${url}...`);

    try {
        const ws = new WebSocket(url);
        activeSocket = ws;

        ws.addEventListener('open', () => {
            notifyStatus('connected', `已连接电脑 Agent (${url})`);
            ws.send(JSON.stringify({
                type: 'hello',
                client: 'TauriTavern-NovelContinuation',
                userAgent: navigator.userAgent,
                viewport: { width: window.innerWidth, height: window.innerHeight },
            }));
        });

        ws.addEventListener('message', async (event) => {
            let msg;
            try {
                msg = JSON.parse(String(event.data || '{}'));
            } catch {
                return;
            }
            if (msg.type !== 'tool_call' || !msg.id) return;

            try {
                const data = await executeRemoteTool(msg.tool, msg.arguments || {}, hooks);
                ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, ok: true, data }));
            } catch (error) {
                ws.send(JSON.stringify({
                    type: 'tool_result',
                    id: msg.id,
                    ok: false,
                    error: String(error?.message || error),
                }));
            }
        });

        ws.addEventListener('close', () => {
            if (activeSocket === ws) activeSocket = null;
            if (!manualDisconnect) {
                notifyStatus('disconnected', '连接已断开，3 秒后尝试自动重连...');
                reconnectTimer = setTimeout(() => {
                    connectRemoteBridge(currentBridgeUrl, hooks, statusCallback);
                }, 3000);
            } else {
                notifyStatus('disconnected', '已手动断开连接');
            }
        });

        ws.addEventListener('error', () => {
            notifyStatus('error', `无法连接到 ${url}，请确认电脑端桥接服务已启动且手机与电脑在同一局域网`);
        });
    } catch (error) {
        notifyStatus('error', `连接异常: ${error?.message || error}`);
    }
}

export function disconnectRemoteBridge() {
    manualDisconnect = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (activeSocket) {
        try {
            activeSocket.close();
        } catch {
            // Ignore
        }
        activeSocket = null;
    }
    notifyStatus('disconnected', '已断开连接');
}
