/**
 * Author-Authentic Multi-Cut Director Outline Generator
 * for the Novel Continuation extension.
 *
 * Pure logic module: zero DOM or network dependencies. All LLM calls are delegated
 * through `callModel` (which applies the user's selected API + Tavern preset).
 */

import { stripNonStoryBlocks } from './parser.js';
import { cleanDistillProse } from './style-distiller.js';

const PACE_LABELS = Object.freeze({
    slow: '温水煮青蛙（稳步铺垫与日常/越界反差，放大信息差，暂不彻底摊牌）',
    medium: '中速推进（制造清晰的小冲突或试探升级，推动主线往前走一大步）',
    climax: '高潮爆点（集中引爆积压矛盾，重点回收所选关键伏笔）',
});

/**
 * Resolves the latest chapter ending (either latest continued chapter or cutoff original chapter)
 * so the Director Outline always connects seamlessly to the exact last sentence.
 */
export function resolveLatestChapterAnchor(novelData, continuedChapters = []) {
    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.chapters?.length || 0);
    const origCutoffCh = (novelData?.chapters || []).find(c => c && Number(c.index) === cutoff) || null;
    const sortedContinued = [...(continuedChapters || [])]
        .filter(c => c && String(c.content || '').trim())
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));

    const latestContinued = sortedContinued.length > 0 ? sortedContinued[sortedContinued.length - 1] : null;
    const anchorCh = latestContinued || origCutoffCh;
    const prevChapterIndex = anchorCh ? Number(anchorCh.index || cutoff) : cutoff;
    const nextChapterIndex = prevChapterIndex + 1;
    const sampleTitle = origCutoffCh?.title || novelData?.chapters?.[0]?.title || '';
    const chapterUnit = /节\s*$/.test(String(sampleTitle).trim()) ? '节' : '章';

    const cleanBody = anchorCh ? stripNonStoryBlocks(anchorCh.content || '').replace(/<\/?game>/gi, '').trim() : '';
    const tailSnippet = cleanBody.slice(-1100);
    const shortClosing = cleanBody.replace(/\s+/g, ' ').slice(-90);

    return {
        prevChapterIndex,
        nextChapterIndex,
        chapterUnit,
        anchorTitle: anchorCh?.title || `第 ${prevChapterIndex} ${chapterUnit}`,
        tailSnippet,
        shortClosing,
    };
}

/**
 * Builds the Director Outline generation prompt grounded in the actual novel ending,
 * chronicle events, 4-dim anti-OOC character soul profiles, selected hooks, and distilled style skeleton.
 *
 * @param {{
 *   novelData?: any,
 *   continuedChapters?: Array<{ index: number, title: string, content: string }>,
 *   ledger?: any,
 *   userBrief?: string,
 *   selectedHookIds?: string[],
 *   sceneCount?: number,
 *   paceMode?: 'slow' | 'medium' | 'climax',
 * }} params
 */
export function buildDirectorOutlinePrompt({
    novelData = null,
    continuedChapters = [],
    ledger = null,
    userBrief = '',
    selectedHookIds = [],
    sceneCount = 4,
    paceMode = 'slow',
}) {
    const anchor = resolveLatestChapterAnchor(novelData, continuedChapters);
    const targetScenes = Math.max(2, Math.min(6, Number(sceneCount) || 4));
    const paceDesc = PACE_LABELS[paceMode] || PACE_LABELS.slow;
    const brief = String(userBrief || '').trim();

    const selectedSet = new Set(selectedHookIds || []);
    const allOpenHooks = (ledger?.hooks || []).filter(h => h && h.status !== 'resolved');
    const chosenHooks = allOpenHooks.filter(h => selectedSet.has(h.id) || (selectedSet.size === 0 && h.status === 'pinned'));
    const backgroundHooks = allOpenHooks.filter(h => !chosenHooks.includes(h)).slice(-8);

    const systemPrompt = [
        '你是原著级长篇小说总导演与分镜策划，负责把作者给出的简略想法（或当前剧情线索）扩写成一份可直接交给续写模型执笔的【原味分镜导演大纲】。',
        '【绝对铁律】：',
        '1. 严格继承原著的叙事结构与节奏骨相：采用多切镜、冷热交替结构（正经推进主线/日常工作 与 私下试探/心理博弈/张力穿插），严禁把整章死磕在同一个房间原地水字数！',
        '2. 只写【时间地点、出场人物、客观事件节拍、对话试探焦点、关键信息差、微动作切入点】，严禁在大纲里塞入网文八股情绪形容词（严禁写“邪魅霸道、屈辱颤抖、气氛黏稠滚烫、声音沙哑、喉结滚动”等词，以免污染下游执笔模型的文风）！',
        '3. 每个登场人物的反应与说话方式必须 100% 遵循《核心人物防 OOC 档案》——寡言角色就安排极简短句或沉默动作，松弛算计角色绝不写成阴鸷霸总！',
        '4. 严格尊重作者输入的「简略过程与结果」和选定的推进步幅，绝不擅自提前摊牌或剧透未到时机的暗线。',
        '5. 直接用 `<director_outline>...</director_outline>` 包裹输出可直接复制给续写模型的大纲正文，不要输出额外寒暄或解释。',
    ].join('\n');

    const parts = [
        `【目标作品】：《${novelData?.title || '当前长篇小说'}》`,
        `【规划目标】：紧接【${anchor.anchorTitle}】结尾，策划【第 ${anchor.nextChapterIndex} ${anchor.chapterUnit}】的详细分镜导演大纲。`,
        `【规划规格】：分 **${targetScenes} 个自然切镜**；推进步幅：**${paceDesc}**。`,
        '',
        brief
            ? `【作者提供的简略过程与结果（最高剧情指令，必须完整落实并自然展开，不得擅自改写作者指定的结果）】：\n${brief}`
            : '【作者未填写具体过程】：请基于下方最新结尾、近期编年史与待填伏笔，自主构思一版最贴合原著走向与节奏的下一章分镜大纲！',
    ];

    if (anchor.tailSnippet) {
        parts.push(
            '',
            `【上一章（${anchor.anchorTitle}）真实结尾原文（本章第 1 镜必须无缝承接此处）】：`,
            anchor.tailSnippet,
        );
    }

    const characters = Array.isArray(ledger?.characters) ? ledger.characters : [];
    if (characters.length > 0) {
        parts.push('', '【核心人物灵魂与防 OOC 红线（大纲中所有人物行为必须严格遵守）】：');
        for (const ch of characters.slice(0, 10)) {
            parts.push(
                `- ${ch.name}${ch.role ? `（${ch.role}）` : ''}：当前处境=${ch.currentSituation || '见前文'} ｜ 真实言行=${ch.voiceAndQuotes || '见原著'} ｜ 🚫OOC红线=${ch.oocRedLines || '严格贴合原著'}`,
            );
        }
    }

    const chronicle = Array.isArray(ledger?.chronicle) ? ledger.chronicle.slice(-8) : [];
    if (chronicle.length > 0) {
        parts.push('', '【近期剧情编年史与现有信息差】：');
        for (const evt of chronicle) {
            parts.push(`- (${evt.chapterRange}) ${evt.title}：${evt.summary}${evt.infoGap ? ` ｜ 信息差：${evt.infoGap}` : ''}`);
        }
    }

    if (chosenHooks.length > 0) {
        parts.push('', '【🎯 本章指定沾边或推进的伏笔（请自然嵌入相应镜头，按步幅决定露半寸针尖还是回收）】：');
        for (const h of chosenHooks) {
            parts.push(`- (#${h.plantedChapter || 1}) ${h.content}`);
        }
    }
    if (backgroundHooks.length > 0) {
        parts.push('', '【🔮 其他尚未到时机的长期暗线（保持悬念，切勿在本章强行摊牌）】：');
        for (const h of backgroundHooks) {
            parts.push(`- (#${h.plantedChapter || 1}) ${h.content}`);
        }
    }

    const sp = ledger?.styleProfile;
    if (sp?.fingerprintText || sp?.styleCard) {
        parts.push('', '【原著文风与节奏骨相参考（确保分镜节奏与原作者习惯一致）】：');
        if (sp.fingerprintText) parts.push(sp.fingerprintText);
        if (sp.styleCard) parts.push(String(sp.styleCard).slice(0, 1200));
    }

    parts.push(
        '',
        '请按如下清爽、可直接发给 AI 续写的结构，包裹在 `<director_outline>...</director_outline>` 中输出（总字数控制在 280 ~ 550 字，高度凝练、招招落地）：',
        '<director_outline>',
        `【第 ${anchor.nextChapterIndex} ${anchor.chapterUnit} 导演分镜大纲（承接：${anchor.anchorTitle}）】`,
        `1. （时间·地点·镜头定位）具体发生了什么客观事件、人物如何互动/试探、谁知道什么或隐瞒什么...`,
        `2. （切镜转场·时间·地点）...`,
        `...（共 ${targetScenes} 个清晰镜头，冷热交替，最后一个镜头明确给出收尾定格画面）`,
        '',
        '【本章执笔纪律】',
        '- 严格复刻原著短段骨相与切镜节奏，不原地水字数、不写网文八股形容词；',
        '- （写出 1~2 条针对本章人物反应边界与“暂不摊牌”的精准控制要求）',
        '</director_outline>',
    );

    return {
        systemPrompt,
        prompt: parts.join('\n'),
        anchor,
    };
}

/**
 * Generates an author-authentic multi-cut Director Outline using the unified preset-wrapped `callModel`.
 */
export async function generateDirectorOutline({
    novelData,
    continuedChapters = [],
    ledger = null,
    userBrief = '',
    selectedHookIds = [],
    sceneCount = 4,
    paceMode = 'slow',
    callModel,
}) {
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }

    const { systemPrompt, prompt, anchor } = buildDirectorOutlinePrompt({
        novelData,
        continuedChapters,
        ledger,
        userBrief,
        selectedHookIds,
        sceneCount,
        paceMode,
    });

    const raw = await callModel({
        stage: 'director_outline_generate',
        systemPrompt,
        prompt,
    });

    const cleaned = cleanDistillProse(raw);
    const match = cleaned.match(/<director_outline>([\s\S]*?)<\/director_outline>/i);
    const outlineText = (match && match[1].trim()) ? match[1].trim() : cleaned;
    if (!outlineText || outlineText.length < 30) {
        throw new Error('生成的大纲内容过短或为空，请检查模型/预设后重试');
    }

    return {
        outlineText,
        targetChapterIndex: anchor.nextChapterIndex,
        anchorTitle: anchor.anchorTitle,
        generatedAt: Date.now(),
    };
}
