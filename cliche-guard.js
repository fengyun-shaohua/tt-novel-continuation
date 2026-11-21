/**
 * Deterministic 0-API AI-Cliché Detector & Surgical De-Cliché Prompt Builder
 * for the Novel Continuation extension. Zero DOM or network dependencies.
 */

import { stripNonStoryBlocks } from './parser.js';

export const DEFAULT_CLICHE_TERMS = Object.freeze([
    '声音沙哑',
    '嗓音沙哑',
    '沙哑地',
    '沙哑的',
    '喉结滚动',
    '喉结微动',
    '喉结上下',
    '一丝不易察觉',
    '不易察觉的',
    '微微眯起眼',
    '眼底闪过一丝',
    '眸色一暗',
    '嘴角勾起',
    '笑意愈发恶劣',
    '唇角微扬',
    '古井无波',
    '空气仿佛凝固',
    '空气黏稠',
    '空气却早已',
    '倒抽了一口凉气',
    '倒吸一口凉气',
    '白桃般的',
    '两枚红宝石',
    '指节泛白',
    '泄露着主人极力掩饰',
    '极力掩饰的羞耻',
]);

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Merges default cliché terms with optional user-defined blacklist lines (one term per line).
 *
 * @param {string} [customBlacklistText='']
 * @returns {string[]}
 */
export function resolveClicheTerms(customBlacklistText = '') {
    const customLines = String(customBlacklistText || '')
        .split(/[\n,，、]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 2);
    return [...new Set([...DEFAULT_CLICHE_TERMS, ...customLines])];
}

/**
 * Scans story text (after stripping `<think_nya>`, `<thinking>`, `<novel_state>`) for AI clichés.
 * Pure, deterministic, 0 API calls.
 *
 * @param {string} rawText
 * @param {string} [customBlacklistText='']
 */
export function scanStoryCliches(rawText, customBlacklistText = '') {
    const clean = stripNonStoryBlocks(rawText)
        .replace(/<\/?game>/gi, '')
        .trim();
    if (!clean) {
        return {
            totalHits: 0,
            uniqueTerms: [],
            hits: [],
            flaggedParagraphIndices: [],
        };
    }

    const terms = resolveClicheTerms(customBlacklistText)
        .sort((a, b) => b.length - a.length);
    const paragraphs = clean.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const hits = [];
    const termSet = new Set();
    const paraSet = new Set();

    paragraphs.forEach((paragraph, paragraphIndex) => {
        const occupiedSpans = [];
        for (const term of terms) {
            const re = new RegExp(escapeRegExp(term), 'gi');
            let match;
            while ((match = re.exec(paragraph)) !== null) {
                const mStart = match.index;
                const mEnd = mStart + match[0].length;
                if (occupiedSpans.some(([s, e]) => mStart < e && mEnd > s)) {
                    continue;
                }
                occupiedSpans.push([mStart, mEnd]);
                const start = Math.max(0, mStart - 22);
                const end = Math.min(paragraph.length, mEnd + 22);
                const prefix = start > 0 ? '…' : '';
                const suffix = end < paragraph.length ? '…' : '';
                hits.push({
                    term,
                    matchedText: match[0],
                    paragraphIndex,
                    snippet: `${prefix}${paragraph.slice(start, end)}${suffix}`,
                    paragraph,
                });
                termSet.add(term);
                paraSet.add(paragraphIndex);
            }
        }
    });

    return {
        totalHits: hits.length,
        uniqueTerms: [...termSet],
        hits,
        flaggedParagraphIndices: [...paraSet].sort((a, b) => a - b),
    };
}

/**
 * Builds anti-Pink-Elephant positive stylistic replacement guidance for continuation prompts.
 * Focuses on concrete replacement reflexes rather than repeating bare negative prohibitions.
 *
 * @param {string} [customBlacklistText='']
 * @returns {string}
 */
export function buildAntiClichePromptGuidance(customBlacklistText = '') {
    const custom = String(customBlacklistText || '')
        .split(/[\n,，、]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 2);
    const lines = [
        '【去网文八股·白描替代铁律（用具体动作与留白取代陈词滥调）】',
        '1. 写开口或情绪波动时：用简短停顿、直接吐字、具体动作细节（垂眼、收手、指尖力道、沉默省略号）呈现，绝不套用喉部吞咽、声线变哑、眼底闪光、嘴角恶劣扬起等高频网文套话。',
        '2. 写环境与氛围时：只落 1~2 笔客观物理感官（灯光、水声、温度、声响），绝不堆砌空洞的情绪形容词、水果/宝石类廉价比喻或大段静态解剖写真。',
        '3. 写人物克制与张力时：把情绪藏进对话缝隙、短促内心独白和细微动作里，绝不替角色做“泄露着极力掩饰的某某情绪”这类上帝视角旁白解说。',
    ];
    if (custom.length > 0) {
        lines.push(`4. 读者额外指定的严禁词表（全章零出现）：${custom.join(' / ')}`);
    }
    return lines.join('\n');
}

/**
 * Builds a surgical 1-shot de-cliché refinement prompt that rewrites ONLY flagged clichés
 * to match the original author's distilled style without altering plot or dialogue facts.
 *
 * @param {{
 *   storyText: string,
 *   scanReport: ReturnType<typeof scanStoryCliches>,
 *   styleProfile?: any,
 *   customBlacklistText?: string,
 * }} params
 */
export function buildSurgicalDeclichePrompt({ storyText, scanReport, styleProfile = null, customBlacklistText = '' }) {
    const flaggedLines = (scanReport?.hits || [])
        .slice(0, 24)
        .map((h, i) => `${i + 1}. 命中【${h.matchedText}】→ 原句片段：${h.snippet}`)
        .join('\n');

    const systemPrompt = [
        '你是专业小说文字责编，正在执行「局部去 AI 八股精修」。',
        '规则：',
        '1. 严格保留原文的全部剧情事件、人物关系、对话意思与尺度，不得删减剧情、不得擅自改写人物性格；',
        '2. 彻底清除下方清单中命中的网文八股词与堆砌形容词，按照《原著文风骨相》把相关句子改成干脆、克制、符合原作者笔触的白描与短段；',
        '3. 直接输出精修后的完整章节正文，不要输出任何开场白、修改说明、列表或评论。',
    ].join('\n');

    const promptParts = [
        '【本次检测命中的 AI 八股清单（必须全部改写消除，且不能换入同类八股）】：',
        flaggedLines || '（全面检查并清除沙哑、喉结滚动、微微眯眼、嘴角恶劣、古井无波、空气黏稠等网文八股）',
        '',
        buildAntiClichePromptGuidance(customBlacklistText),
    ];

    if (styleProfile?.styleCard) {
        promptParts.push('', '【原著文风骨相铁律（精修笔触参照）】：', String(styleProfile.styleCard).slice(0, 2400));
    }
    if (styleProfile?.goldenExcerpts) {
        promptParts.push('', '【原著灵魂原文范例（模仿其简洁节奏）】：', String(styleProfile.goldenExcerpts).slice(0, 1400));
    }

    promptParts.push('', '【待精修章节正文】：', String(storyText || '').trim());

    return {
        systemPrompt,
        prompt: promptParts.join('\n'),
    };
}
