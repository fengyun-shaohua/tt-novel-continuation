import { extension_settings, getContext } from '/scripts/extensions.js';
import { getPresetManager } from '/scripts/preset-manager.js';
import {
    applyReaderBodyClasses,
    closeWorkbench,
    openWorkbench,
    refreshReaderWidgets,
    scrollToChatFloor,
} from './reader-ui.js';
import {
    hasStoryBlueprint,
    loadCanonDb,
    loadLedger,
    loadNovelData,
    normalizeStoryBlueprint,
    saveLedger,
    saveNovelData,
} from './storage.js';

let activeSocket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let manualDisconnect = false;
let currentBridgeUrl = '';
let statusCallback = null;

const HOT_STYLE_ID = 'tt-novel-remote-hot-css';
const CLIENT_VERSION = '1.9.2';
const CLIENT_SESSION_ID = `tt_sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/* ==========================================================================
   Lightweight Error/Console Fallback Ring Buffer (works even outside Tauri)
   ========================================================================== */
const FALLBACK_LOG_LIMIT = 150;
const fallbackLogs = [];
let fallbackCaptureInstalled = false;

function pushFallbackLog(level, message, target = '') {
    fallbackLogs.push({
        id: fallbackLogs.length + 1,
        timestampMs: Date.now(),
        level,
        message: String(message || '').slice(0, 1200),
        target: target || undefined,
    });
    if (fallbackLogs.length > FALLBACK_LOG_LIMIT) {
        fallbackLogs.splice(0, fallbackLogs.length - FALLBACK_LOG_LIMIT);
    }
}

function formatLogArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack.slice(0, 400)}` : ''}`;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

function installFallbackLogCapture() {
    if (fallbackCaptureInstalled) return;
    fallbackCaptureInstalled = true;

    window.addEventListener('error', (evt) => {
        const loc = evt?.filename ? `${evt.filename}:${evt.lineno || 0}` : 'window.error';
        pushFallbackLog('error', evt?.error ? formatLogArg(evt.error) : (evt?.message || 'Unknown error'), loc);
    });
    window.addEventListener('unhandledrejection', (evt) => {
        pushFallbackLog('error', `UnhandledRejection: ${formatLogArg(evt?.reason)}`, 'promise');
    });

    for (const lvl of ['error', 'warn']) {
        const orig = console[lvl];
        if (typeof orig !== 'function') continue;
        console[lvl] = function (...args) {
            try {
                pushFallbackLog(lvl, args.map(formatLogArg).join(' '), 'console');
            } catch {
                // Never break console logging
            }
            return orig.apply(this, args);
        };
    }
}

/* ==========================================================================
   Safe JSON Serialization & Sensitivity Guard
   ========================================================================== */
function isSensitiveElement(el) {
    if (!(el instanceof Element)) return false;
    if (el.matches('input[type="password"], [data-tt-sensitive], [data-private]')) return true;
    const idOrName = `${el.id || ''} ${el.getAttribute('name') || ''}`.toLowerCase();
    return /api[_-]?key|secret|password|token|credential/.test(idOrName);
}

function redactSettingsObject(settings) {
    const out = {};
    for (const [k, v] of Object.entries(settings || {})) {
        if (/key|secret|token|password/i.test(k) && typeof v === 'string' && v.trim()) {
            out[k] = `[REDACTED:${v.length}chars]`;
        } else {
            out[k] = v;
        }
    }
    return out;
}

function safeSerialize(value, maxDepth = 6) {
    const seen = new WeakSet();
    function walk(val, depth) {
        if (val === null || val === undefined) return val;
        const t = typeof val;
        if (t === 'string' || t === 'number' || t === 'boolean') return val;
        if (t === 'bigint') return `${val}n`;
        if (t === 'function') return `[Function ${val.name || 'anonymous'}]`;
        if (t === 'symbol') return String(val);
        if (val instanceof Error) {
            return { name: val.name, message: val.message, stack: String(val.stack || '').slice(0, 800) };
        }
        if (typeof Element !== 'undefined' && val instanceof Element) {
            return `[Element <${val.tagName.toLowerCase()}${val.id ? `#${val.id}` : ''}>]`;
        }
        if (depth >= maxDepth) {
            return Array.isArray(val) ? `[Array(${val.length})]` : '[Object]';
        }
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
        if (val instanceof Map) {
            return Object.fromEntries([...val.entries()].slice(0, 100).map(([k, v]) => [String(k), walk(v, depth + 1)]));
        }
        if (val instanceof Set) {
            return [...val.values()].slice(0, 100).map(v => walk(v, depth + 1));
        }
        if (Array.isArray(val)) {
            return val.slice(0, 200).map(v => walk(v, depth + 1));
        }
        const out = {};
        for (const [k, v] of Object.entries(val).slice(0, 120)) {
            if (/api[_-]?key|authorization|secret|password/i.test(k) && typeof v === 'string' && v.length > 6) {
                out[k] = `[REDACTED:${v.length}chars]`;
            } else {
                out[k] = walk(v, depth + 1);
            }
        }
        return out;
    }
    return walk(value, 0);
}

function isElementVisible(el) {
    if (!(el instanceof Element)) return false;
    if (el.hasAttribute('hidden')) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    return true;
}

function describeSelector(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
        : '';
    return cls ? `${tag}.${cls}` : tag;
}

function findElementByTarget({ selector = '', textContains = '' } = {}) {
    if (selector) {
        return document.querySelector(selector);
    }
    const needle = String(textContains || '').trim().toLowerCase();
    if (!needle) return null;
    const candidates = [...document.querySelectorAll('button, a, summary, label, input, select, textarea, [role="tab"], [role="button"]')];
    return candidates.find(el => isElementVisible(el) && String(el.textContent || el.getAttribute('title') || '').toLowerCase().includes(needle)) || null;
}

/* ==========================================================================
   DOM Snapshot & Mobile Layout Audit
   ========================================================================== */
function buildDomSnapshot({
    selector = '',
    textContains = '',
    maxDepth = 4,
    maxMatches = 15,
    visibleOnly = true,
    includeStyles = true,
    maxTextLength = 240,
} = {}) {
    let roots = [];
    const cap = Math.max(1, Math.min(40, Number(maxMatches) || 15));
    const needle = String(textContains || '').trim().toLowerCase();

    if (needle) {
        const scope = selector ? document.querySelector(selector) : document.body;
        if (scope) {
            const all = [...scope.querySelectorAll('*')];
            roots = all.filter((el) => {
                if (visibleOnly && !isElementVisible(el)) return false;
                const direct = [...el.childNodes]
                    .filter(n => n.nodeType === Node.TEXT_NODE)
                    .map(n => n.textContent || '')
                    .join(' ')
                    .toLowerCase();
                return direct.includes(needle);
            }).slice(0, cap);
        }
    } else {
        const effSelector = selector || '#chat';
        roots = [...document.querySelectorAll(effSelector)]
            .filter(el => !visibleOnly || isElementVisible(el))
            .slice(0, cap);
    }

    if (roots.length === 0) {
        return { found: false, selector: selector || '(text search)', textContains: needle || undefined, matches: [] };
    }

    function serializeNode(el, depth) {
        if (!(el instanceof Element)) return null;
        if (visibleOnly && depth > 0 && !isElementVisible(el)) return null;
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

        for (const attrName of ['mesid', 'is_user', 'is_system', 'title', 'data-tab', 'data-action', 'open', 'disabled']) {
            if (el.hasAttribute(attrName)) {
                node.attrs[attrName] = el.getAttribute(attrName);
            }
        }
        if (Object.keys(node.attrs).length === 0) delete node.attrs;

        if (includeStyles) {
            const cs = window.getComputedStyle(el);
            node.style = {
                display: cs.display,
                position: cs.position !== 'static' ? cs.position : undefined,
                flexShrink: cs.flexShrink !== '1' ? cs.flexShrink : undefined,
                overflow: cs.overflow !== 'visible' ? cs.overflow : undefined,
                fontSize: cs.fontSize,
                padding: cs.padding !== '0px' ? cs.padding : undefined,
                color: cs.color,
                backgroundColor: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : undefined,
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
            const kids = [...el.children]
                .slice(0, 30)
                .map(child => serializeNode(child, depth + 1))
                .filter(Boolean);
            if (kids.length > 0) node.children = kids;
        } else if (el.children.length > 0) {
            node.childCount = el.children.length;
        }

        return node;
    }

    return {
        found: true,
        selector: selector || undefined,
        textContains: needle || undefined,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        matches: roots.map(r => serializeNode(r, 0)).filter(Boolean),
    };
}

function runLayoutAudit({ selector = '', maxIssues = 20 } = {}) {
    const wbOverlay = document.getElementById('tt-novel-wb-overlay');
    const wbVisible = wbOverlay && !wbOverlay.classList.contains('displayNone');
    const rootSelector = selector || (wbVisible ? '#tt-novel-wb-overlay' : 'body');
    const root = document.querySelector(rootSelector);
    if (!root) {
        return { found: false, rootSelector, error: `未找到根容器 ${rootSelector}` };
    }

    const cap = Math.max(5, Math.min(60, Number(maxIssues) || 20));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const collapsedFlexItems = [];
    const horizontalOverflows = [];
    const clippedContainers = [];

    const nodes = [...root.querySelectorAll('*')];
    for (const el of nodes) {
        if (!isElementVisible(el)) continue;
        if (el.tagName === 'SVG' || el.tagName === 'PATH' || el.tagName === 'LINE' || el.tagName === 'POLYLINE' || el.tagName === 'POLYGON' || el.tagName === 'RECT' || el.tagName === 'CIRCLE') continue;
        const rect = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        const textPreview = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);

        // 1. Collapsed visible element that has text or non-empty scrollHeight (classic flex-shrink bug)
        if (
            collapsedFlexItems.length < cap &&
            rect.height <= 2 &&
            el.scrollHeight > 12 &&
            textPreview.length > 0 &&
            !el.closest('details:not([open]) > :not(summary)')
        ) {
            collapsedFlexItems.push({
                element: describeSelector(el),
                parent: describeSelector(el.parentElement),
                rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
                scrollHeight: el.scrollHeight,
                flexShrink: cs.flexShrink,
                text: textPreview,
            });
        }

        // 2. Exceeds right edge of viewport
        if (
            horizontalOverflows.length < cap &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > vw + 4 &&
            cs.overflowX !== 'auto' &&
            cs.overflowX !== 'scroll'
        ) {
            horizontalOverflows.push({
                element: describeSelector(el),
                right: Math.round(rect.right),
                viewportWidth: vw,
                overflowPx: Math.round(rect.right - vw),
                text: textPreview,
            });
        }

        // 3. Container clipping children without scroll
        if (
            clippedContainers.length < cap &&
            cs.overflowY === 'hidden' &&
            el.scrollHeight > el.clientHeight + 8 &&
            el.clientHeight > 0 &&
            !el.matches('details:not([open])')
        ) {
            clippedContainers.push({
                element: describeSelector(el),
                clientHeight: el.clientHeight,
                scrollHeight: el.scrollHeight,
                flexShrink: cs.flexShrink,
                text: textPreview,
            });
        }
    }

    return {
        found: true,
        rootSelector,
        viewport: { width: vw, height: vh, dpr: window.devicePixelRatio || 1 },
        checkedElements: nodes.length,
        issueSummary: {
            collapsedFlexItems: collapsedFlexItems.length,
            horizontalOverflows: horizontalOverflows.length,
            clippedContainers: clippedContainers.length,
        },
        collapsedFlexItems,
        horizontalOverflows,
        clippedContainers,
    };
}

/* ==========================================================================
   Native TauriTavern `api.dev` Logs & LLM API Logs Inspection
   ========================================================================== */
function getTauriDevApi() {
    return globalThis.__TAURITAVERN__?.api?.dev || null;
}

async function handleLogsTool({ source = 'frontend', level = 'all', grep = '', limit = 50, enableCapture = false, clearBuffer = false } = {}) {
    const dev = getTauriDevApi();
    const maxItems = Math.max(1, Math.min(300, Number(limit) || 50));
    const needle = String(grep || '').trim().toLowerCase();
    const lvlFilter = String(level || 'all').toLowerCase();

    const filterList = (items) => (items || []).filter((it) => {
        const lv = String(it?.level || '').toLowerCase();
        if (lvlFilter !== 'all' && lv !== lvlFilter) return false;
        if (needle) {
            const hay = `${it?.target || ''} ${it?.message || ''}`.toLowerCase();
            if (!hay.includes(needle)) return false;
        }
        return true;
    }).slice(-maxItems);

    if (enableCapture && dev?.frontendLogs?.setConsoleCaptureEnabled) {
        await dev.frontendLogs.setConsoleCaptureEnabled(true);
    }

    const result = {
        hasNativeDevApi: Boolean(dev),
        source,
        level: lvlFilter,
    };

    if (source === 'frontend' || source === 'all') {
        let nativeEntries = [];
        let captureEnabled = null;
        if (dev?.frontendLogs?.list) {
            captureEnabled = await dev.frontendLogs.getConsoleCaptureEnabled?.().catch(() => null);
            nativeEntries = await dev.frontendLogs.list({ limit: Math.max(maxItems * 2, 120) }).catch(() => []);
        }
        const merged = nativeEntries.length > 0 ? nativeEntries : fallbackLogs;
        result.frontendCaptureEnabled = captureEnabled;
        result.frontendLogs = filterList(merged);
        result.frontendSource = nativeEntries.length > 0 ? 'api.dev.frontendLogs' : 'plugin_fallback_buffer';
        if (clearBuffer) fallbackLogs.length = 0;
    }

    if (source === 'backend' || source === 'all') {
        if (dev?.backendLogs?.tail) {
            const rawBackend = await dev.backendLogs.tail({ limit: Math.max(maxItems * 2, 120) }).catch(() => []);
            result.backendLogs = filterList(rawBackend);
        } else {
            result.backendLogs = [];
            result.backendNote = '当前运行环境不提供 api.dev.backendLogs（仅 TauriTavern 原生宿主支持）';
        }
    }

    return result;
}

async function handleLlmLogsTool({ action = 'index', id = null, limit = 10, section = 'both', offset = 0, maxChars = 12000 } = {}) {
    const dev = getTauriDevApi();
    if (!dev?.llmApiLogs) {
        return {
            available: false,
            error: '当前运行环境不支持 window.__TAURITAVERN__.api.dev.llmApiLogs（仅 TauriTavern 宿主提供完整原生 LLM API 日志）。',
        };
    }

    const indexLimit = Math.max(1, Math.min(50, Number(limit) || 10));
    const entries = await dev.llmApiLogs.index({ limit: indexLimit });
    if (action === 'index') {
        return {
            available: true,
            count: entries.length,
            entries,
        };
    }

    const targetId = Number.isFinite(Number(id)) && Number(id) > 0
        ? Number(id)
        : entries[0]?.id;
    if (!targetId) {
        return { available: true, count: 0, error: '当前没有已记录的 LLM API 请求日志。' };
    }

    const start = Math.max(0, Number(offset) || 0);
    const budget = Math.max(500, Math.min(80000, Number(maxChars) || 12000));
    const sliceText = (str) => {
        const s = String(str ?? '');
        const sliced = s.slice(start, start + budget);
        return {
            totalChars: s.length,
            offset: start,
            returnedChars: sliced.length,
            hasMore: start + sliced.length < s.length,
            text: sliced,
        };
    };

    if (action === 'raw') {
        const raw = await dev.llmApiLogs.getRaw(targetId);
        return {
            available: true,
            id: targetId,
            responseRawKind: raw?.responseRawKind || null,
            request: section !== 'response' ? sliceText(raw?.requestRaw) : undefined,
            response: section !== 'request' ? sliceText(raw?.responseRaw) : undefined,
        };
    }

    const preview = await dev.llmApiLogs.getPreview(targetId);
    return {
        available: true,
        id: targetId,
        meta: {
            timestampMs: preview?.timestampMs,
            level: preview?.level,
            ok: preview?.ok,
            source: preview?.source,
            model: preview?.model,
            endpoint: preview?.endpoint,
            durationMs: preview?.durationMs,
            stream: preview?.stream,
            errorMessage: preview?.errorMessage,
            responseRawKind: preview?.responseRawKind,
        },
        request: section !== 'response' ? sliceText(preview?.requestReadable) : undefined,
        response: section !== 'request' ? sliceText(preview?.responseReadable) : undefined,
    };
}

/* ==========================================================================
   Structured Tavern & Novel State Inspector (`tt_tavern_inspect`)
   ========================================================================== */
async function handleTavernInspect({ scope = 'overview', startFloor = null, endFloor = null, limit = 10, fullText = false, filter = '' } = {}, hooks) {
    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const dev = getTauriDevApi();

    if (scope === 'presets') {
        const pm = getPresetManager?.('openai');
        const activeName = pm?.getSelectedPresetName?.() || null;
        const presetNames = typeof pm?.getPresetList === 'function' ? Object.keys(pm.getPresetList().preset_names || {}) : [];
        const activePreset = activeName && typeof pm?.getCompletionPresetByName === 'function'
            ? pm.getCompletionPresetByName(activeName)
            : null;
        const thPresets = extension_settings?.tavern_helper?.script?.enabled?.presets || [];
        const needle = String(filter || '').trim().toLowerCase();
        const prompts = Array.isArray(activePreset?.prompts)
            ? activePreset.prompts
                .filter(p => !needle || `${p.identifier || ''} ${p.name || ''} ${p.content || ''}`.toLowerCase().includes(needle))
                .slice(0, 60)
                .map(p => ({
                    identifier: p.identifier,
                    name: p.name,
                    role: p.role,
                    enabled: p.enabled,
                    chars: String(p.content || '').length,
                }))
            : [];
        return {
            activePresetName: activeName,
            installedPresetsCount: presetNames.length,
            installedPresets: presetNames.slice(0, 40),
            hasSPreset: Boolean(activePreset?.extensions?.SPreset),
            regexScriptCount: Array.isArray(activePreset?.extensions?.regex_scripts) ? activePreset.extensions.regex_scripts.length : 0,
            tavernHelperAllowedPresets: thPresets,
            prompts,
        };
    }

    if (scope === 'worldinfo') {
        const wi = extension_settings?.world_info || {};
        const selected = Array.isArray(wi.selected) ? wi.selected : [];
        return {
            selectedWorldBooks: selected,
            globalScanDepth: wi.depth,
            budgetPercent: wi.budget,
            charBook: context?.characters?.[context?.characterId]?.data?.extensions?.world || null,
        };
    }

    if (scope === 'chat') {
        const cap = Math.max(1, Math.min(30, Number(limit) || 10));
        const hasRange = Number.isFinite(Number(startFloor)) || Number.isFinite(Number(endFloor));
        const sIdx = hasRange ? Math.max(0, Number(startFloor) || 0) : Math.max(0, chat.length - cap);
        const eIdx = hasRange
            ? Math.min(chat.length - 1, Number.isFinite(Number(endFloor)) ? Number(endFloor) : (sIdx + cap - 1))
            : chat.length - 1;
        const items = [];
        for (let i = sIdx; i <= eIdx && items.length < cap; i += 1) {
            const m = chat[i];
            if (!m) continue;
            const rawMes = String(m.mes || '');
            items.push({
                floorIndex: i,
                is_user: Boolean(m.is_user),
                is_system: Boolean(m.is_system),
                name: m.name,
                mesChars: rawMes.length,
                mes: fullText ? rawMes : rawMes.slice(0, 800),
                swipeCount: Array.isArray(m.swipes) ? m.swipes.length : 1,
                swipeId: m.swipe_id ?? 0,
                origin: m.extra?.novelContinuationOrigin || null,
                chapterIndex: m.extra?.novelChapterIndex || null,
            });
        }
        return {
            totalFloors: chat.length,
            returnedRange: items.length > 0 ? [items[0].floorIndex, items[items.length - 1].floorIndex] : [],
            messages: items,
        };
    }

    if (scope === 'novel') {
        const [novelData, ledger, canonDb] = await Promise.all([loadNovelData(), loadLedger(), loadCanonDb()]);
        const bp = normalizeStoryBlueprint(ledger.storyBlueprint);
        return {
            novel: novelData
                ? {
                    title: novelData.title,
                    totalChapters: novelData.totalChapters,
                    cutoffChapterIndex: novelData.cutoffChapterIndex,
                    viewingChapterIndex: novelData.viewingChapterIndex,
                }
                : null,
            blueprint: hasStoryBlueprint(bp)
                ? {
                    title: bp.title,
                    creationMode: bp.creationMode,
                    genreAndTone: bp.genreAndTone,
                    premiseChars: bp.premise.length,
                    volumes: bp.volumes.map(v => ({
                        index: v.index,
                        title: v.title,
                        chapterRange: v.chapterRange,
                        status: v.status,
                        hasRecap: Boolean(v.recap),
                    })),
                }
                : null,
            narrativeConfig: ledger.narrativeConfig,
            counts: {
                characters: ledger.characters.length,
                chronicle: ledger.chronicle.length,
                openHooks: ledger.hooks.filter(h => h.status !== 'resolved').length,
                summaries: ledger.summaries.length,
                worldStates: ledger.worldStates.length,
                canonItems: canonDb.items.length,
                archiveBatches: (ledger.archiveBatches || []).length,
            },
            characterNames: ledger.characters.map(c => c.name),
            styleProfile: ledger.styleProfile
                ? {
                    styleCardChars: String(ledger.styleProfile.styleCard || '').length,
                    goldenExcerptsChars: String(ledger.styleProfile.goldenExcerpts || '').length,
                    roundHistory: ledger.styleProfile.roundHistory || [],
                }
                : null,
            settings: redactSettingsObject(hooks.getSettings()),
        };
    }

    if (scope === 'extensions') {
        return {
            extensionSettingKeys: Object.keys(extension_settings || {}),
            hasTauriTavernApi: Boolean(globalThis.__TAURITAVERN__?.api),
            hasDevApi: Boolean(dev),
            hasWorkbenchDom: Boolean(document.getElementById('tt-novel-wb-overlay')),
            workbenchOpen: Boolean(document.getElementById('tt-novel-wb-overlay') && !document.getElementById('tt-novel-wb-overlay').classList.contains('displayNone')),
            novelPluginVersion: CLIENT_VERSION,
        };
    }

    // Default: 'overview'
    const [novelData, ledger, canonDb] = await Promise.all([loadNovelData(), loadLedger(), loadCanonDb()]);
    const pm = getPresetManager?.('openai');
    const recentErrors = fallbackLogs.filter(l => l.level === 'error').slice(-5);
    const latestLlm = dev?.llmApiLogs?.index ? (await dev.llmApiLogs.index({ limit: 3 }).catch(() => [])) : [];
    const wbOverlay = document.getElementById('tt-novel-wb-overlay');
    return {
        connected: true,
        clientVersion: CLIENT_VERSION,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        hasNativeDevApi: Boolean(dev),
        activePresetName: pm?.getSelectedPresetName?.() || null,
        characterName: context?.name2 || null,
        chatId: context?.getCurrentChatId?.() || context?.chatId || null,
        chatFloorCount: chat.length,
        workbenchOpen: Boolean(wbOverlay && !wbOverlay.classList.contains('displayNone')),
        novel: novelData
            ? { title: novelData.title, totalChapters: novelData.totalChapters, cutoffChapterIndex: novelData.cutoffChapterIndex }
            : (hasStoryBlueprint(ledger.storyBlueprint)
                ? { title: ledger.storyBlueprint.title, mode: ledger.storyBlueprint.creationMode, volumes: ledger.storyBlueprint.volumes?.length || 0 }
                : null),
        ledgerCounts: {
            characters: ledger.characters.length,
            chronicle: ledger.chronicle.length,
            openHooks: ledger.hooks.filter(h => h.status !== 'resolved').length,
            summaries: ledger.summaries.length,
            canonItems: canonDb.items.length,
        },
        recentErrorsCount: recentErrors.length,
        recentErrors,
        latestLlmRequests: latestLlm,
    };
}

/* ==========================================================================
   Unified Remote Tool Dispatcher
   ========================================================================== */
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
                clientVersion: CLIENT_VERSION,
                hasNativeDevApi: Boolean(getTauriDevApi()),
                viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
                bodyClasses: [...document.body.classList],
                characterName: context?.name2 || null,
                chatId: context?.getCurrentChatId?.() || context?.chatId || null,
                chatFloorCount: Array.isArray(context?.chat) ? context.chat.length : 0,
                settings: redactSettingsObject(hooks.getSettings()),
                novel: novelData
                    ? {
                        title: novelData.title,
                        totalChapters: novelData.totalChapters,
                        cutoffChapterIndex: novelData.cutoffChapterIndex,
                    }
                    : null,
                blueprint: hasStoryBlueprint(ledger.storyBlueprint)
                    ? {
                        title: ledger.storyBlueprint.title,
                        creationMode: ledger.storyBlueprint.creationMode,
                        volumesCount: ledger.storyBlueprint.volumes?.length || 0,
                    }
                    : null,
                ledgerSummary: {
                    charactersCount: ledger.characters.length,
                    chronicleCount: ledger.chronicle.length,
                    summariesCount: ledger.summaries.length,
                    worldStatesCount: ledger.worldStates.length,
                    openHooks: ledger.hooks.filter(h => h.status !== 'resolved'),
                },
                canonDbCount: canonDb.items.length,
                recentErrorsCount: fallbackLogs.filter(l => l.level === 'error').length,
            };
        }

        case 'tt_tavern_inspect':
            return await handleTavernInspect(args, hooks);

        case 'tt_logs':
            return await handleLogsTool(args);

        case 'tt_llm_logs':
            return await handleLlmLogsTool(args);

        case 'tt_layout_audit':
            return runLayoutAudit(args);

        case 'tt_dom_snapshot':
            return buildDomSnapshot(args);

        case 'tt_hot_css': {
            const mode = ['replace', 'append', 'clear', 'get'].includes(args.mode) ? args.mode : 'replace';
            let styleEl = document.getElementById(HOT_STYLE_ID);
            if (mode === 'get') {
                return { ok: true, css: styleEl?.textContent || '', length: (styleEl?.textContent || '').length };
            }
            if (mode === 'clear') {
                styleEl?.remove();
                return { ok: true, cleared: true, length: 0 };
            }
            const cssText = String(args.css ?? '');
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = HOT_STYLE_ID;
                document.head.appendChild(styleEl);
            }
            styleEl.textContent = mode === 'append' ? `${styleEl.textContent}\n${cssText}` : cssText;
            return { ok: true, mode, length: styleEl.textContent.length };
        }

        case 'tt_interact': {
            const { action, selector, textContains, value, waitMs } = args;
            if (action === 'open_workbench') {
                await openWorkbench(String(value || 'create'));
            } else if (action === 'close_workbench') {
                closeWorkbench();
            } else if (action === 'reload_page') {
                setTimeout(() => window.location.reload(), 120);
                return { ok: true, action: 'reload_page', note: '页面将在 120ms 后刷新并自动重连桥接' };
            } else if (action === 'scroll_floor') {
                await scrollToChatFloor(Number(value) || 0);
            } else if (action === 'press_key') {
                const key = String(value || 'Escape');
                const targetEl = selector ? document.querySelector(selector) : document;
                targetEl?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            } else {
                const el = findElementByTarget({ selector, textContains });
                if (!el) throw new Error(`未找到目标元素 (selector=${selector || '无'}, text=${textContains || '无'})`);
                if (isSensitiveElement(el)) throw new Error(`拒绝操作敏感元素: ${describeSelector(el)}`);

                if (action === 'click') {
                    /** @type {HTMLElement} */ (el).click();
                } else if (action === 'fill' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
                    el.value = String(value ?? '');
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (action === 'check' && el instanceof HTMLInputElement) {
                    el.checked = Boolean(value);
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (action === 'select' && el instanceof HTMLSelectElement) {
                    el.value = String(value ?? '');
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (action === 'scroll_into_view') {
                    el.scrollIntoView({ behavior: 'instant', block: 'center' });
                } else {
                    throw new Error(`不支持的交互动作或元素类型不匹配: ${action} on <${el.tagName.toLowerCase()}>`);
                }
            }

            const delay = Math.max(0, Math.min(5000, Number(waitMs) || 0));
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            return { ok: true, action, selector: selector || undefined, textContains: textContains || undefined };
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
            if (action === 'get_blueprint') {
                const ledger = await loadLedger();
                return normalizeStoryBlueprint(ledger.storyBlueprint);
            }
            if (action === 'set_blueprint' && payload) {
                const ledger = await loadLedger();
                ledger.storyBlueprint = normalizeStoryBlueprint(payload);
                await saveLedger(ledger);
                await refreshReaderWidgets();
                return { ok: true, blueprint: ledger.storyBlueprint };
            }
            if (action === 'get_characters') {
                const ledger = await loadLedger();
                return { count: ledger.characters.length, characters: ledger.characters };
            }
            if (action === 'get_summaries') {
                const ledger = await loadLedger();
                return { count: ledger.summaries.length, summaries: ledger.summaries };
            }
            if (action === 'get_canon') {
                return await loadCanonDb();
            }
            if (action === 'update_settings' && payload && typeof payload === 'object') {
                const settings = hooks.getSettings();
                Object.assign(settings, payload);
                hooks.saveExtensionSettings();
                applyReaderBodyClasses(settings);
                await refreshReaderWidgets();
                return { ok: true, settings: redactSettingsObject(settings) };
            }
            if (action === 'get_chat_messages') {
                const chat = context?.chat || [];
                const limit = Math.min(30, Math.max(1, Number(payload?.limit) || 5));
                const full = Boolean(payload?.fullText);
                const slice = chat.slice(-limit);
                const startFloor = Math.max(0, chat.length - slice.length);
                return slice.map((m, idx) => ({
                    floorIndex: startFloor + idx,
                    is_user: Boolean(m.is_user),
                    name: m.name,
                    mesPreview: full ? String(m.mes || '') : String(m.mes || '').slice(0, 800),
                    reasoningPreview: String(m.extra?.reasoning || '').slice(0, 300),
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
            const helpers = {
                loadLedger,
                saveLedger,
                loadNovelData,
                loadCanonDb,
                openWorkbench,
                closeWorkbench,
                refreshReaderWidgets,
                scrollToChatFloor,
            };
            const fn = new AsyncFunction('context', 'api', 'dev', 'helpers', 'document', 'window', code);
            const result = await fn(context, globalThis.__TAURITAVERN__?.api, getTauriDevApi(), helpers, document, window);
            return { result: safeSerialize(result ?? null) };
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
    installFallbackLogCapture();
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
            reconnectAttempt = 0;
            notifyStatus('connected', `已连接电脑 Agent (${url})`);
            const ctx = getContext();
            ws.send(JSON.stringify({
                type: 'hello',
                client: 'TauriTavern-NovelContinuation',
                clientVersion: CLIENT_VERSION,
                clientSessionId: CLIENT_SESSION_ID,
                characterName: ctx?.name2 || '',
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
            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
                return;
            }
            if (msg.type !== 'tool_call' || !msg.id) return;

            try {
                const data = await executeRemoteTool(msg.tool, msg.arguments || {}, hooks);
                ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, ok: true, data: safeSerialize(data, 8) }));
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
                reconnectAttempt += 1;
                const delayMs = Math.min(20000, 3000 * Math.pow(1.6, Math.min(reconnectAttempt - 1, 4)));
                const delaySec = Math.round(delayMs / 1000);
                notifyStatus('disconnected', `连接已断开，${delaySec} 秒后自动重连...`);
                reconnectTimer = setTimeout(() => {
                    connectRemoteBridge(currentBridgeUrl, hooks, statusCallback);
                }, delayMs);
            } else {
                notifyStatus('disconnected', '已手动断开连接');
            }
        });

        ws.addEventListener('error', () => {
            notifyStatus('error', `无法连接 ${url}，请确认电脑端桥接已启动且在同一局域网`);
        });
    } catch (error) {
        notifyStatus('error', `连接异常: ${error?.message || error}`);
    }
}

export function disconnectRemoteBridge() {
    manualDisconnect = true;
    reconnectAttempt = 0;
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
