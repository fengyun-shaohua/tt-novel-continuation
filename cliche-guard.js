/**
 * Deterministic 0-API AI-Cliché Detector, Draft Refusal/Empty Gate,
 * Surgical De-Cliché Refiner, and 5-Step Deep Diagnosis & Rewrite Engine
 * for the Novel Continuation extension. Zero DOM or network dependencies.
 */

import { extractNovelStateBlock, stripNonStoryBlocks } from './parser.js';
import { isModelRefusalText } from './story-archiver.js';
import { cleanDistillProse, computeLocalStyleFingerprint, sanitizeStyleCardText } from './style-distiller.js';

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
    '眼眸微眯',
    '眼底闪过一丝',
    '眸色一暗',
    '深不见底',
    '嘴角勾起',
    '裂开一道',
    '狰狞邪异',
    '笑意愈发恶劣',
    '唇角微扬',
    '古井无波',
    '空气仿佛凝固',
    '空气黏稠',
    '空气却早已',
    '倒抽了一口凉气',
    '倒吸一口凉气',
    '如遭雷击',
    '冻结成冰',
    '血液仿佛凝固',
    '血脉偾张',
    '白桃般的',
    '两枚红宝石',
    '指节泛白',
    '指节发白',
    '指节青紫',
    '青紫色的',
    '青紫的',
    '泛起青紫',
    '青筋暴起',
    '指甲掐进',
    '指甲深深',
    '嵌进掌心',
    '掐进肉里',
    '渗出血丝',
    '惨白如纸',
    '血色褪尽',
    '毫无血色',
    '绝望的泪水',
    '滚烫的泪水',
    '生理性泪水',
    '泪水无声滑落',
    '泪水顺着眼角',
    '泪水模糊了视线',
    '泪水夺眶而出',
    '淌着泪水',
    '绝望的呜咽',
    '满眼绝望',
    '彻底绝望',
    '空洞失神',
    '如坠冰窟',
    '彻底崩塌',
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
        '4. 写压抑、震惊、无力或沉沦时（严禁廉价苦情八股）：除非大纲明确要求痛哭或受伤，否则严禁动不动让角色“流泪/滚烫泪水滑落/绝望呜咽/空洞失神/惨白如纸/如坠冰窟”，更严禁反复描写“青紫色的手/指节泛白青紫/青筋暴起/指甲掐进掌心渗血”！改用平实的停顿、视线移开、僵住半拍或极简短句来承接情绪。',
    ];
    if (custom.length > 0) {
        lines.push(`5. 读者额外指定的严禁词表（全章零出现）：${custom.join(' / ')}`);
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
export function buildSurgicalDeclichePrompt({
    storyText,
    scanReport,
    styleProfile = null,
    customBlacklistText = '',
    worldInfoContext = '',
    narrativeConfig = null,
}) {
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
    if (worldInfoContext && String(worldInfoContext).trim()) {
        promptParts.push(
            '',
            `【已激活酒馆世界书设定（精修时严禁擅自改动角色外貌、服装与世界观专有设定）】：`,
            String(worldInfoContext).trim().slice(0, 6000),
        );
    }
    if (narrativeConfig?.povMode === 'strict_limited' && narrativeConfig?.povCharacter) {
        promptParts.push(
            '',
            `【单视角保护】：本书严格锁定「${narrativeConfig.povCharacter}」视角，精修时严禁引入其他人物的内心独白或上帝视角旁白。`,
        );
    }

    promptParts.push('', '【待精修章节正文】：', String(storyText || '').trim());

    return {
        systemPrompt,
        prompt: promptParts.join('\n'),
    };
}

/**
 * Validates a generated chapter draft BEFORE triggering a rewrite API call.
 * Blocks empty responses, non-story-only responses (`<think_nya>` only), abnormally truncated drafts,
 * and model apologies/refusals so we never waste rewrite tokens on broken drafts.
 *
 * @param {string} rawDraftText
 * @param {{ minChars?: number }} [options]
 * @returns {{ ok: true, storyText: string, charCount: number } | { ok: false, reasonCode: 'empty' | 'refused' | 'too_short', reason: string, storyText: string, charCount: number }}
 */
export function validateDraftForRewrite(rawDraftText, { minChars = 120 } = {}) {
    const storyText = cleanDistillProse(rawDraftText);
    const charCount = storyText.replace(/\s+/g, '').length;

    if (!storyText || charCount === 0) {
        return {
            ok: false,
            reasonCode: 'empty',
            reason: '检测到初稿正文为空（空回或仅含思考标签），已自动拦截，未消耗重写 API',
            storyText: '',
            charCount: 0,
        };
    }

    if (/^(?:\[(?:API\s*错误|错误|Error)\]|API\s*Error\s*:)/i.test(storyText) || /(?:安全连接失败：|请求地址:\s*https?:\/\/)/i.test(storyText)) {
        return {
            ok: false,
            reasonCode: 'api_error',
            reason: '检测到初稿为 API/网络报错提示而非小说正文，已自动拦截，未消耗重写 API',
            storyText,
            charCount,
        };
    }

    if (isModelRefusalText(storyText)) {
        return {
            ok: false,
            reasonCode: 'refused',
            reason: `检测到初稿为模型道歉/拒答内容（“${storyText.slice(0, 48)}…”），已自动拦截，未消耗重写 API`,
            storyText,
            charCount,
        };
    }

    const threshold = Math.max(40, Number(minChars) || 120);
    if (charCount < threshold) {
        return {
            ok: false,
            reasonCode: 'too_short',
            reason: `检测到初稿过短（仅 ${charCount} 字，低于 ${threshold} 字门槛，疑似异常截断或空回），已自动拦截，未消耗重写 API`,
            storyText,
            charCount,
        };
    }

    return {
        ok: true,
        storyText,
        charCount,
    };
}

function buildDraftDriftSummary(draftText, styleProfile) {
    const targetFp = styleProfile?.fingerprint;
    if (!targetFp || !draftText) return '';
    const draftFp = computeLocalStyleFingerprint([{ index: 1, title: '', content: draftText }], 1);
    const alerts = [];
    if (targetFp.avgParagraphChars > 0) {
        const ratio = (draftFp.avgParagraphChars - targetFp.avgParagraphChars) / targetFp.avgParagraphChars;
        if (ratio >= 0.3) {
            alerts.push(`平均段长偏长（初稿 ${draftFp.avgParagraphChars} 字 vs 原著 ${targetFp.avgParagraphChars} 字），重写时必须拆短自然段！`);
        } else if (ratio <= -0.35) {
            alerts.push(`平均段长偏碎（初稿 ${draftFp.avgParagraphChars} 字 vs 原著 ${targetFp.avgParagraphChars} 字）`);
        }
    }
    if (Number.isFinite(targetFp.shortParagraphRatio) && (draftFp.shortParagraphRatio - targetFp.shortParagraphRatio) <= -15) {
        alerts.push(`≤60字短段占比偏低（初稿 ${draftFp.shortParagraphRatio}% vs 原著 ${targetFp.shortParagraphRatio}%）`);
    }
    if (Number.isFinite(targetFp.dialogueRatio) && Math.abs(draftFp.dialogueRatio - targetFp.dialogueRatio) >= 15) {
        alerts.push(`对话占比偏离原著（初稿 ${draftFp.dialogueRatio}% vs 原著 ${targetFp.dialogueRatio}%）`);
    }
    return [
        `• 平均段长：原著 ${targetFp.avgParagraphChars} 字（≤60字短段 ${targetFp.shortParagraphRatio ?? '?'}%） vs 初稿 ${draftFp.avgParagraphChars} 字（短段 ${draftFp.shortParagraphRatio ?? '?'}%）`,
        `• 句长与对话：原著均句 ${targetFp.avgSentenceChars} 字 / 对话占比 ${targetFp.dialogueRatio}% vs 初稿均句 ${draftFp.avgSentenceChars} 字 / 对话占比 ${draftFp.dialogueRatio}%`,
        alerts.length > 0 ? `• 客观文风硬偏差：${alerts.join('；')}` : '• 段长与对话密度基本贴合原著，重点主抓 OOC、台词质感与信息差。',
    ].join('\n');
}

/**
 * Builds the 5-item `<pre>` Deep Diagnosis + `<content>` Full Reconstruction prompt
 * grounded in the novel's previous chapter anchor, author outline, 4-dim anti-OOC character profiles,
 * story chronicle info-gaps, distilled Style Bible, and 0-API cliché & paragraph-drift diagnostics.
 */
export function buildDeepRewritePrompt({
    draftText,
    chapterIndex = 1,
    authorOutline = '',
    prevChapterAnchor = null,
    novelData = null,
    ledger = null,
    scanReport = null,
    customBlacklistText = '',
    extraDirective = '',
    worldInfoContext = '',
    narrativeConfig = null,
    recentChaptersBridgeLines = [],
    includeNovelState = false,
}) {
    const activeCfg = narrativeConfig || ledger?.narrativeConfig || {};
    const strictPov = activeCfg.povMode === 'strict_limited' && Boolean(String(activeCfg.povCharacter || '').trim());
    const povChar = strictPov ? String(activeCfg.povCharacter).trim() : '';
    const cleanDraft = cleanDistillProse(draftText);
    const driftSummary = buildDraftDriftSummary(cleanDraft, ledger?.styleProfile);
    const flaggedCliches = (scanReport?.hits || [])
        .slice(0, 20)
        .map((h, i) => `${i + 1}. 【${h.matchedText}】→ ${h.snippet}`)
        .join('\n');

    const systemPrompt = [
        '【重写指令】',
        '你是原著级长篇小说总编与终审执笔人。上一轮初稿正文质量未达原著水准，必须在保留既定事件边界、上一章承接与作者本章大纲意图的前提下，彻底推翻并重塑行文骨架、切镜节奏与人物台词——严禁在旧稿基础上同义改写或小修小补！',
        '',
        '写正文前，先用 `<pre>...</pre>` 完成精准诊断与重写规划（总计控制在 800-1200 字，直击要害，禁止车轱辘话与情绪化检讨）；`</pre>` 后空一行，再写 `<content>...</content>` 输出完整重写后的章节正文。',
        '',
        '`<pre>` 须严格按以下 5 项展开：',
        '',
        '1. 角色与行为逻辑（列出 3-4 个具体病灶）',
        '   - 对照《核心人物防 OOC 档案》，指出哪处行为 OOC、心理转折跳步，或角色沦为机械推进剧情的工具人。',
        '   - 对照《近期编年史与信息差》，检查是否存在信息差穿帮（角色知道了其视角不可能知道的事），以及是否靠上帝视角旁白“贴标签”代替具体动作刻画。',
        '',
        '2. 台词排雷（直接摘录 3-5 句初稿原台词）',
        '   - 逐句摘录初稿中尬、怪、翻译腔、舞台腔、长度违背角色寡言/话多设定，或把潜台词直接说透的句子。',
        '   - 一句话点明病根，并对照人物原著声线锚点给出替代方向。',
        '',
        '3. 剧情发散与结构（去套路、去平铺直叙）',
        '   - 诊断初稿是否只是机械照念大纲、原地水戏或落入廉价桥段。',
        '   - 在不破坏上章承接、不篡改本章大纲既定结果的前提下，构思 1-2 个合乎情理的细节变量（如环境反作用、小插曲、角色私心与顾虑，或更巧妙的切镜视角），让场景自然生长。',
        '',
        '4. 设定融入、着装与文风骨相（查世界书一致、去科普、去 AI 味、对齐原著段长）',
        '   - 核对初稿中人物的外貌、日常着装/配饰及世界观设定是否与下方《已激活酒馆世界书》及《角色当前外观与着装锚点》保持一致，严禁擅自变装或混搭不同服饰！',
        ...(strictPov ? [`   - 核查严格单视角边界：严禁出现「${povChar}」不在场的他人独处镜头、其他角色内心独白或未获知情报的未卜先知！`] : []),
        '   - 结合本地客观物理统计偏差与八股命中清单，排查生硬的“说明书式科普”、脱离原著骨相的冗长灌水段落。',
        '   - 清理高频网文套路（机械微表情模板、强行排比升华、过度堆砌比喻、结尾强行抛问句等）。',
        '',
        '5. 本轮重写执行蓝图（紧贴正文前的最高优先级指令，只写正面做法，共 4-6 条）',
        '   - 【保留边界】：不可篡改的上一章衔接点、既定事实与本章大纲核心事件结果。',
        '   - 【起笔切入】：无缝承接上章结尾前提下全新的开场画面或微动作切入角度，禁止沿用旧稿第一段句式。',
        '   - 【核心落地】：将上述 1-4 点的修改浓缩为具体的多切镜节奏、微动作、对话拉扯与情绪递进。',
        '   - 【收尾落点】：以具体行动、对话留白或氛围余韵自然收束本章，顺畅引出下一章（绝不留出互动选项或强行抛问句）。',
        '   - 【本轮禁区】：点名禁止再次出现的尬词、旧句式、OOC 表达与八股套路。',
        '',
        '【正文铁律（`<content>...</content>` 内严格执行）】',
        '- `<content>` 必须逐条兑现第 5 部分的「执行蓝图」，做到蓝图即执笔纲要，严禁分析一套、正文照旧。',
        '- 彻底重塑行文骨架与台词，同时保持与初稿相当或更扎实的篇幅，绝不得偷工减料缩水剧情。',
        '- 避免为摆脱俗套而走向“刻意拧巴、装腔作势或晦涩难懂”的另一极端；保持贴合原著的克制、自然、有生活质感与呼吸感的叙事。',
        '- `<content>` 内只放纯净小说正文，不要输出任何分析、批注、互动选项或结束语。',
    ].join('\n');

    const parts = [
        `【重写目标】：《${novelData?.title || '当前长篇小说'}》第 ${chapterIndex} 章 · 深度诊断与推翻重塑`,
    ];

    if (extraDirective && String(extraDirective).trim()) {
        parts.push('', `【作者本轮额外指定重点（最高优先级落实）】：\n${String(extraDirective).trim()}`);
    }

    if (authorOutline && String(authorOutline).trim()) {
        parts.push('', `【本章原定大纲与不可篡改的事件边界】：\n${String(authorOutline).trim().slice(0, 1800)}`);
    }

    if (prevChapterAnchor?.tailSnippet) {
        parts.push(
            '',
            `【上一章（${prevChapterAnchor.anchorTitle || `第 ${Math.max(1, chapterIndex - 1)} 章`}）真实结尾锚点（重写开篇必须无缝承接此处）】：`,
            prevChapterAnchor.tailSnippet.slice(-560),
        );
    }

    if (driftSummary) {
        parts.push('', '【📊 本地 0-API 客观文风骨相偏差体检（原著 vs 初稿）】：', driftSummary);
    }

    if (flaggedCliches) {
        parts.push('', '【🚫 本地 0-API 检出的初稿高频 AI 八股清单（重写中必须彻底清零）】：', flaggedCliches);
    }
    if (customBlacklistText && String(customBlacklistText).trim()) {
        parts.push('', buildAntiClichePromptGuidance(customBlacklistText));
    }

    const characters = Array.isArray(ledger?.characters) ? ledger.characters : [];
    if (characters.length > 0) {
        parts.push('', '【核心人物 4 维灵魂、当前着装与防 OOC 档案（第 1、2、4 项诊断的硬裁判依据）】：');
        for (const ch of characters.slice(0, 8)) {
            const appearPart = ch.currentAppearance ? ` ｜ 👔当前外观与着装=${ch.currentAppearance}` : '';
            parts.push(
                `- ${ch.name}${ch.role ? `（${ch.role}）` : ''}：当前处境=${ch.currentSituation || '见前文'}${appearPart} ｜ 原著声线与原话=${ch.voiceAndQuotes || '见原著'} ｜ 🚫OOC红线=${ch.oocRedLines || '严格贴合原著'}`,
            );
        }
    }

    if (worldInfoContext && String(worldInfoContext).trim()) {
        const wiRule = activeCfg.worldInfoPriority === 'wi_strict'
            ? '严格遵循世界书中的角色外貌、日常服装与世界观硬设定，重写时若初稿衣服/设定穿帮必须立刻纠偏'
            : '世界书提供角色基础外貌与世界观底骨；若本小说已明确改写着装或剧情换装，则锁定人物当前着装锚点，严禁混搭两套衣服';
        parts.push(
            '',
            `【已激活酒馆世界书设定（${wiRule}）】：`,
            String(worldInfoContext).trim(),
        );
    }

    if (strictPov) {
        parts.push(
            '',
            `【严格单视角（Limited POV）硬红线】：全章必须 100% 锁定在「${povChar}」的感官与已知信息范围内！若初稿切去了他人独处视角、泄露了「${povChar}」不可能知道的幕后信息，重写时必须删改并重构为仅通过「${povChar}」可感知的细节与线索推进。`,
        );
    }
    if (activeCfg.referenceTimelineMode) {
        const refLabel = activeCfg.referencePovLabel || '已完结基准时间线';
        const refCursor = Number(activeCfg.referenceCursorChapter || 0);
        const refLookahead = Math.max(2, Math.min(20, Number(activeCfg.referenceLookaheadChapters) || 8));
        const refChapters = (novelData?.chapters || [])
            .filter(c => c && c.timelineRole === 'reference' && Number(c.index) > refCursor && Number(c.index) <= refCursor + Math.min(3, refLookahead))
            .sort((a, b) => Number(a.index) - Number(b.index));
        const refLines = [
            `【🧭 平行视角基准时间线核查（${refLabel} · 已对齐至第 ${refCursor} 章）】：重写时严禁违背基准时间线既定顺序，严禁重复已发生节点或凭空多编同类大事件！`,
        ];
        for (const ch of refChapters) {
            const snippet = stripNonStoryBlocks(ch.content || '').replace(/\s+/g, ' ').trim().slice(0, 320);
            refLines.push(`- [基准#${ch.index} ${ch.title}]：${snippet}`);
        }
        parts.push('', refLines.join('\n'));
    }

    const chronicle = Array.isArray(ledger?.chronicle) ? ledger.chronicle.slice(-8) : [];
    if (chronicle.length > 0) {
        parts.push('', '【近期编年史与信息差（严查上帝视角穿帮）】：');
        for (const evt of chronicle) {
            parts.push(`- (${evt.chapterRange}) ${evt.title}：${evt.summary}${evt.infoGap ? ` ｜ 信息差：${evt.infoGap}` : ''}`);
        }
    }

    if (Array.isArray(recentChaptersBridgeLines) && recentChaptersBridgeLines.length > 0) {
        parts.push('', '【📌 近期尚未并入编年史的已写章节实录（重写时严禁与刚写完的前几章矛盾或重复）】：', ...recentChaptersBridgeLines);
    }

    if (ledger?.styleProfile?.goldenExcerpts) {
        parts.push('', '【原著灵魂原文范例（重写语感与对话节奏的最高活标尺）】：', String(ledger.styleProfile.goldenExcerpts).slice(0, 1200));
    }
    if (ledger?.styleProfile?.styleCard) {
        const cleanCard = sanitizeStyleCardText(ledger.styleProfile.styleCard);
        if (cleanCard) {
            parts.push('', '【原著文风骨相 DNA 圣经（重写笔触与段长标尺）】：', cleanCard.slice(0, 2200));
        }
    }

    const refAutoOn = Boolean(activeCfg.referenceTimelineMode && activeCfg.autoAdvanceRefCursor !== false);
    const curRefCursor = Number(activeCfg.referenceCursorChapter || 0);
    const stateTrailerReminder = includeNovelState
        ? [
            '',
            '【可选末段状态块】：在 `</content>` 之后另起一行附带 `<novel_state>` 块（前端会自动提取入账并隐藏，绝不混入正文）：',
            `<novel_state><chapter_summary>第 ${chapterIndex} 章一句话核心总结（80字内）</chapter_summary><worldbook>- 人物|角色名：本章状态变动（无则写无）；外观|角色名：着装变动（无变化省略）</worldbook><hooks>- [新伏笔] 本章新埋线索（无则写无）；[已填坑] 本章回收旧伏笔（无则写无）</hooks>${refAutoOn ? `<ref_cursor>${curRefCursor}或推进后的新基准章号(纯数字)</ref_cursor>` : ''}</novel_state>`,
        ]
        : [];

    parts.push(
        '',
        `【待推翻重塑的上一轮初稿正文（共 ${cleanDraft.replace(/\s+/g, '').length} 字）】：`,
        cleanDraft,
        '',
        '【输出标签硬性提醒】：请严格先输出 `<pre>...</pre>`（仅放 5 项精准诊断与重写执行蓝图），紧接空一行后输出 `<content>...</content>`（仅放纯净小说正文，绝不要把“第一部分/深度诊断报告/第二部分”等审稿文字写进正文里）。',
        ...stateTrailerReminder,
    );

    return {
        systemPrompt,
        prompt: parts.join('\n'),
        driftSummary,
    };
}

/**
 * Parses `<pre>...</pre>` diagnosis, `<content>...</content>` rewritten prose, and optional `<novel_state>`
 * from Deep Rewrite output, with Markdown two-part fallback and strict post-rewrite guards.
 *
 * @param {string} rawOutput
 * @param {number} [originalStoryLength=0]
 * @returns {{ diagnosisPre: string, rewrittenContent: string, extractedState: ReturnType<typeof extractNovelStateBlock> }}
 */
export function parseDeepRewriteResponse(rawOutput, originalStoryLength = 0) {
    const extractedState = extractNovelStateBlock(rawOutput);
    const cleaned = cleanDistillProse(extractedState.cleanText);
    if (!cleaned) {
        throw new Error('重写模型返回为空，已保留原初稿未覆盖');
    }

    const preMatch = cleaned.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i);
    let diagnosisPre = preMatch ? preMatch[1].trim() : '';

    // 1) Primary: explicit `<content>...</content>` (or truncated unclosed `<content>...`)
    const contentMatch = cleaned.match(/<content\b[^>]*>([\s\S]*?)(?:<\/content>|$)/i);
    let rewrittenContent = '';
    if (contentMatch && contentMatch[1].trim()) {
        rewrittenContent = contentMatch[1].trim();
    } else if (preMatch) {
        // 2) Fallback: everything after `</pre>` when `<content>` wrapper was omitted
        const afterPreIdx = preMatch.index + preMatch[0].length;
        rewrittenContent = cleaned.slice(afterPreIdx).replace(/<\/?content\b[^>]*>/gi, '').trim();
    } else {
        // 3) Fallback: Markdown two-part format (e.g. `### 【第一部分：深度诊断报告】 ... --- ### 【第二部分：...正文】`)
        const part2HeadingRe = /(?:^|\n)(?:[-*_]{3,}\s*\n+)?[ \t]*(?:#{1,4}\s*|\*{2}\s*)?【?(?:第[二2]部分[：:\s]*[^\n]*|推翻重塑(?:后)?(?:的)?(?:完整)?(?:章节)?正文[^\n]*|重写(?:后)?(?:的)?(?:完整)?(?:章节)?正文[^\n]*|正式正文[^\n]*|最终正文[^\n]*)】?\*{0,2}[ \t]*(?:\n|$)/i;
        const part2Match = cleaned.match(part2HeadingRe);
        if (part2Match) {
            diagnosisPre = cleaned.slice(0, part2Match.index).replace(/\n[-*_]{3,}\s*$/, '').trim();
            rewrittenContent = cleaned.slice(part2Match.index + part2Match[0].length).trim();
        } else {
            // 4) Fallback: starts with diagnosis block then transitions into `### 第 N 章`
            const looksLikeDiagLead = /^(?:#{1,4}\s*)?【?(?:第[一1]部分|深度诊断|病灶诊断|重写诊断|1\.\s*\*{0,2}(?:角色|人物))/i.test(cleaned);
            if (looksLikeDiagLead) {
                const chSplitRe = /\n(?:[-*_]{3,}\s*\n+)?(?=#{1,4}\s*第\s*[0-9一二三四五六七八九十百千]+\s*[章节回])/;
                const chMatch = cleaned.match(chSplitRe);
                if (chMatch) {
                    diagnosisPre = cleaned.slice(0, chMatch.index).replace(/\n[-*_]{3,}\s*$/, '').trim();
                    rewrittenContent = cleaned.slice(chMatch.index + chMatch[0].length).trim();
                } else {
                    throw new Error('重写模型仅输出了诊断报告、未分离出正文段落，已保留原初稿未覆盖');
                }
            } else {
                rewrittenContent = cleaned;
            }
        }
    }

    // Strip any accidental leading Part-2 wrapper heading, HTML comments, or nested shells from story prose
    rewrittenContent = cleanDistillProse(rewrittenContent)
        .replace(/^(?:#{1,4}\s*|\*{2}\s*)?【?(?:第[二2]部分[：:\s]*[^\n]*|推翻重塑(?:后)?(?:的)?(?:完整)?(?:章节)?正文[^\n]*|重写(?:后)?(?:的)?(?:完整)?(?:章节)?正文[^\n]*)】?\*{0,2}\s*\n+/i, '')
        .trim();

    if (/^(?:#{1,4}\s*)?【?(?:第[一1]部分|深度诊断报告|病灶诊断)/i.test(rewrittenContent)) {
        throw new Error('检测到诊断报告混入正文开头且未能分离正文，已保留原初稿未覆盖');
    }

    const rewrittenChars = rewrittenContent.replace(/\s+/g, '').length;

    if (!rewrittenContent || rewrittenChars === 0) {
        throw new Error('重写模型未输出有效正文 <content>，已保留原初稿未覆盖');
    }

    if (isModelRefusalText(rewrittenContent)) {
        throw new Error(`重写模型返回了道歉/拒答内容，已保留原初稿未覆盖：${rewrittenContent.slice(0, 100)}`);
    }

    const minAccepted = Math.max(120, Math.floor(Number(originalStoryLength || 0) * 0.35));
    if (rewrittenChars < minAccepted) {
        throw new Error(`重写返回正文异常过短（仅 ${rewrittenChars} 字，低于保底 ${minAccepted} 字），已保留原初稿未覆盖`);
    }

    return {
        diagnosisPre,
        rewrittenContent,
        extractedState,
    };
}
