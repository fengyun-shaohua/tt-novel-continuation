/**
 * Author-Authentic Single-Chapter & Multi-Chapter Arc Director Outline Generator
 * for the Novel Continuation extension.
 *
 * Pure logic module: zero DOM or network dependencies. All LLM calls are delegated
 * through `callModel` (which applies the user's selected API + Tavern preset).
 */

import { stripNonStoryBlocks } from './parser.js';
import { isModelRefusalText } from './story-archiver.js';
import { cleanDistillProse } from './style-distiller.js';

const PACE_LABELS = Object.freeze({
    slow: '温水煮青蛙（稳步铺垫、日常推进与暗线反差，放大信息差，暂不彻底摊牌）',
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
 * Parses single- or multi-chapter director outlines from `<chapter_outline>` tags,
 * with fallback splitting on `【第 N 章` / `### 第 N 章` headings and `<director_outline>`.
 *
 * @param {string} rawText
 * @param {number} startChapterIndex
 * @param {string} [chapterUnit='章']
 * @returns {Array<{ id: string, chapterIndex: number, title: string, text: string, sent: boolean }>}
 */
export function parseMultiChapterOutlines(rawText, startChapterIndex = 1, chapterUnit = '章') {
    const cleaned = cleanDistillProse(rawText);
    if (!cleaned) return [];

    const results = [];
    const tagRegex = /<chapter_outline(?:\s+[^>]*)?>([\s\S]*?)(?:<\/chapter_outline>|(?=<chapter_outline\b)|$)/gi;
    let match;
    let seq = 0;

    while ((match = tagRegex.exec(cleaned)) !== null) {
        const fullTag = match[0];
        const body = String(match[1] || '').trim();
        if (!body) continue;

        const openTag = fullTag.slice(0, fullTag.indexOf('>') + 1);
        const idxAttr = openTag.match(/index\s*=\s*["']?(\d+)["']?/i);
        const titleAttr = openTag.match(/title\s*=\s*["']([^"']+)["']/i);
        const chapterIndex = idxAttr ? Number(idxAttr[1]) : (startChapterIndex + seq);
        const firstLine = body.split('\n').map(l => l.trim()).find(Boolean) || '';
        const derivedTitle = titleAttr?.[1]?.trim()
            || firstLine.replace(/^[【#*\s]+|[】*\s]+$/g, '').slice(0, 42)
            || `第 ${chapterIndex} ${chapterUnit}`;

        results.push({
            id: `outline_ch_${chapterIndex}_${seq + 1}`,
            chapterIndex,
            title: derivedTitle,
            text: body,
            sent: false,
        });
        seq += 1;
    }

    if (results.length > 0) {
        return results;
    }

    // Fallback 1: `<director_outline>` wrapper
    const singleWrap = cleaned.match(/<director_outline>([\s\S]*?)(?:<\/director_outline>|$)/i);
    const bodyText = singleWrap && singleWrap[1].trim() ? singleWrap[1].trim() : cleaned;

    // Fallback 2: split multi-chapter headings (`【第 59 章...】`, `### 第 59 章...`, `**第 59 章...**`)
    const headingSplit = bodyText
        .split(/\n(?=(?:#{1,4}\s*|\*{2}\s*【?|【)第\s*\d+\s*[章节回])/)
        .map(s => s.replace(/\n[-*_]{3,}\s*$/, '').trim())
        .filter(Boolean);

    if (headingSplit.length >= 2) {
        return headingSplit.map((chunk, i) => {
            const firstLine = chunk.split('\n')[0].trim();
            const numMatch = firstLine.match(/第\s*(\d+)\s*[章节回]/);
            const chapterIndex = numMatch ? Number(numMatch[1]) : (startChapterIndex + i);
            const title = firstLine.replace(/^[【#*\s]+|[】*\s]+$/g, '').slice(0, 42) || `第 ${chapterIndex} ${chapterUnit}`;
            return {
                id: `outline_ch_${chapterIndex}_${i + 1}`,
                chapterIndex,
                title,
                text: chunk,
                sent: false,
            };
        });
    }

    const firstLine = bodyText.split('\n').map(l => l.trim()).find(Boolean) || '';
    const title = firstLine.replace(/^[【#*\s]+|[】*\s]+$/g, '').slice(0, 42) || `第 ${startChapterIndex} ${chapterUnit}`;
    return [{
        id: `outline_ch_${startChapterIndex}_1`,
        chapterIndex: startChapterIndex,
        title,
        text: bodyText,
        sent: false,
    }];
}

/**
 * Builds the Single-Chapter or Multi-Chapter Arc Director Outline prompt grounded in
 * the actual novel ending, chronicle events, 4-dim anti-OOC character soul profiles,
 * selected hooks, and distilled style skeleton.
 */
export function buildDirectorOutlinePrompt({
    novelData = null,
    continuedChapters = [],
    ledger = null,
    userBrief = '',
    selectedHookIds = [],
    sceneCount = 4,
    chapterCount = 1,
    paceMode = 'slow',
}) {
    const anchor = resolveLatestChapterAnchor(novelData, continuedChapters);
    const targetChapters = Math.max(1, Math.min(8, Number(chapterCount) || 1));
    const targetScenes = Math.max(2, Math.min(6, Number(sceneCount) || 4));
    const paceDesc = PACE_LABELS[paceMode] || PACE_LABELS.slow;
    const brief = String(userBrief || '').trim();
    const endChapterIndex = anchor.nextChapterIndex + targetChapters - 1;
    const isMulti = targetChapters > 1;

    const selectedSet = new Set(selectedHookIds || []);
    const allOpenHooks = (ledger?.hooks || []).filter(h => h && h.status !== 'resolved');
    const chosenHooks = allOpenHooks.filter(h => selectedSet.has(h.id) || (selectedSet.size === 0 && h.status === 'pinned'));
    const backgroundHooks = allOpenHooks.filter(h => !chosenHooks.includes(h)).slice(-8);

    const systemPrompt = [
        '你是原著级长篇小说总导演与卷纲/分镜策划，负责把作者给出的简略过程与结果扩写成可直接逐章交给续写模型执笔的【原味分镜导演大纲】。',
        '【绝对铁律】：',
        '1. 严格继承原著的叙事结构与节奏骨相：每章采用多切镜、冷热交替结构（主线推进/日常工作 与 伏笔埋设/对话博弈 穿插），严禁把整章死磕在同一个房间原地水字数！',
        '2. 只写【时间地点、出场人物、客观事件节拍、对话试探焦点、关键信息差、微动作切入点】，严禁在大纲里塞入网文八股情绪形容词（严禁写“邪魅霸道、声音沙哑、喉结滚动、空气仿佛凝固、一丝不易察觉”等词，以免污染下游执笔模型的文风）！',
        '3. 每个登场人物的反应与说话方式必须 100% 遵循《核心人物防 OOC 档案》——寡言角色就安排极简短句或沉默动作，松弛算计角色绝不写成阴鸷霸总！',
        '4. 若一次规划多章，必须合理拆解节奏与递进层次（起承转合、章末留钩、下章紧接上章结尾，绝不把所有剧情和伏笔堆在第 1 章写完，也不得重复水戏）！',
        '5. 严格按要求的 `<chapter_outline index="章号" title="章节简短标题">...</chapter_outline>` 标签输出每一章，不要输出额外寒暄或解释。',
    ].join('\n');

    const parts = [
        `【目标作品】：《${novelData?.title || '当前长篇小说'}》`,
        isMulti
            ? `【规划目标】：紧接【${anchor.anchorTitle}】结尾，一次性连贯规划 **连续 ${targetChapters} ${anchor.chapterUnit}**（第 ${anchor.nextChapterIndex} ~ ${endChapterIndex} ${anchor.chapterUnit}）的分章导演大纲！`
            : `【规划目标】：紧接【${anchor.anchorTitle}】结尾，策划【第 ${anchor.nextChapterIndex} ${anchor.chapterUnit}】的详细分镜导演大纲。`,
        `【规划规格】：每章分 **${targetScenes} 个自然切镜**；整体推进步幅：**${paceDesc}**。`,
        '',
        brief
            ? `【作者提供的简略过程与结果（最高剧情指令，必须完整落实${isMulti ? `并合理分配到第 ${anchor.nextChapterIndex}~${endChapterIndex} ${anchor.chapterUnit}中层层递进` : '并自然展开'}，不得擅自改写作者指定的结果）】：\n${brief}`
            : `【作者未填写具体过程】：请基于下方最新结尾、近期编年史与待填伏笔，自主构思一版最贴合原著走向与节奏的${isMulti ? `连续 ${targetChapters} ${anchor.chapterUnit}` : '下一章'}分镜大纲！`,
    ];

    if (anchor.tailSnippet) {
        parts.push(
            '',
            `【上一章（${anchor.anchorTitle}）真实结尾原文（第 ${anchor.nextChapterIndex} ${anchor.chapterUnit}第 1 镜必须无缝承接此处）】：`,
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
        parts.push('', `【🎯 本次规划指定沾边或推进的伏笔（${isMulti ? '请均匀分布到不同章节中层层递进，勿全堆在同一章' : '请自然嵌入相应镜头'}）】：`);
        for (const h of chosenHooks) {
            parts.push(`- (#${h.plantedChapter || 1}) ${h.content}`);
        }
    }
    if (backgroundHooks.length > 0) {
        parts.push('', '【🔮 其他尚未到时机的长期暗线（保持悬念，切勿强行摊牌）】：');
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

    const perChapterBudget = targetChapters >= 5 ? '220 ~ 360 字' : '280 ~ 480 字';
    parts.push(
        '',
        `请严格输出 **${targetChapters} 个** \`<chapter_outline>\` 标签块（从第 ${anchor.nextChapterIndex} ${anchor.chapterUnit}到第 ${endChapterIndex} ${anchor.chapterUnit}，每章独立完整、可直接复制发给 AI 续写，每章约 ${perChapterBudget}）：`,
        `<chapter_outline index="${anchor.nextChapterIndex}" title="第 ${anchor.nextChapterIndex} ${anchor.chapterUnit} · 简短标题">`,
        `【第 ${anchor.nextChapterIndex} ${anchor.chapterUnit} 导演分镜大纲（承接：${anchor.anchorTitle}）】`,
        `1. （时间·地点·镜头定位）具体客观事件、对话试探焦点、信息差...`,
        `2. （切镜转场·时间·地点）...`,
        `...（共 ${targetScenes} 个清晰镜头，冷热交替，最后一个镜头给出收尾定格并自然引出下一章）`,
        '',
        '【本章执笔纪律】',
        '- 严格复刻原著短段骨相与切镜节奏，不原地水字数、不写网文八股形容词；',
        '- （针对本章人物反应边界与“暂不摊牌”的精准控制要求）',
        '</chapter_outline>',
        ...(isMulti
            ? [`（接着按相同格式依次输出第 ${anchor.nextChapterIndex + 1} ${anchor.chapterUnit} 直至第 ${endChapterIndex} ${anchor.chapterUnit}，共 ${targetChapters} 个独立 \`<chapter_outline>\` 块）`]
            : []),
    );

    return {
        systemPrompt,
        prompt: parts.join('\n'),
        anchor,
        targetChapters,
    };
}

/**
 * Generates a single-chapter or multi-chapter arc Director Outline using the unified preset-wrapped `callModel`.
 */
export async function generateDirectorOutline({
    novelData,
    continuedChapters = [],
    ledger = null,
    userBrief = '',
    selectedHookIds = [],
    sceneCount = 4,
    chapterCount = 1,
    paceMode = 'slow',
    callModel,
}) {
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }

    const { systemPrompt, prompt, anchor, targetChapters } = buildDirectorOutlinePrompt({
        novelData,
        continuedChapters,
        ledger,
        userBrief,
        selectedHookIds,
        sceneCount,
        chapterCount,
        paceMode,
    });

    const raw = await callModel({
        stage: targetChapters > 1 ? `director_outline_arc_${targetChapters}ch` : 'director_outline_generate',
        systemPrompt,
        prompt,
    });

    const cleanedRaw = cleanDistillProse(raw);
    const hasOutlineTags = /<(?:chapter_outline|director_outline)\b/i.test(cleanedRaw);
    if (!hasOutlineTags && isModelRefusalText(cleanedRaw)) {
        throw new Error(`模型返回了拒答/道歉内容（未保存为大纲）：${cleanedRaw.slice(0, 120)}`);
    }

    const chapters = parseMultiChapterOutlines(raw, anchor.nextChapterIndex, anchor.chapterUnit);
    if (chapters.length === 0 || chapters.every(c => c.text.length < 25)) {
        throw new Error('生成的大纲内容过短或为空，请检查模型/预设后重试');
    }
    if (chapters.length === 1 && chapters[0].text.length < 300 && isModelRefusalText(chapters[0].text)) {
        throw new Error(`模型返回了拒答/道歉内容（未保存为大纲）：${chapters[0].text.slice(0, 120)}`);
    }

    const combinedText = chapters.map(c => c.text).join('\n\n---\n\n');
    return {
        chapters,
        outlineText: combinedText,
        targetChapterIndex: anchor.nextChapterIndex,
        endChapterIndex: chapters[chapters.length - 1].chapterIndex,
        chapterCount: chapters.length,
        anchorTitle: anchor.anchorTitle,
        generatedAt: Date.now(),
    };
}
