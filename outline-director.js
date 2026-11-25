/**
 * Author-Authentic Single-Chapter & Multi-Chapter Arc Director Outline Generator
 * for the Novel Continuation extension.
 *
 * Pure logic module: zero DOM or network dependencies. All LLM calls are delegated
 * through `callModel` (which applies the user's selected API + Tavern preset).
 */

import {
    buildStoryBlueprintContextBlock,
    buildUnarchivedRecentChaptersBridge,
    hasStoryBlueprintData,
    resolveActiveVolume,
} from './context-assembler.js';
import { stripNonStoryBlocks } from './parser.js';
import { isModelRefusalText, parseCharacterProfiles } from './story-archiver.js';
import { cleanDistillProse, sanitizeStyleCardText, throwIfAborted } from './style-distiller.js';

const PACE_LABELS = Object.freeze({
    slow: '温水煮青蛙（稳步铺垫、日常推进与暗线反差，放大信息差，暂不彻底摊牌）',
    medium: '中速推进（制造清晰的小冲突或试探升级，推动主线往前走一大步）',
    climax: '高潮爆点（集中引爆积压矛盾，重点回收所选关键伏笔）',
});

/**
 * Resolves the latest chapter ending (either latest continued chapter or cutoff original chapter)
 * so the Director Outline always connects seamlessly to the exact last sentence.
 */
export function resolveLatestChapterAnchor(novelData, continuedChapters = [], { excludeFlashback = true } = {}) {
    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.chapters?.length || 0);
    const eligibleOriginals = (novelData?.chapters || [])
        .filter(c => {
            if (!c || Number(c.index) > cutoff) return false;
            if (c.timelineRole === 'skip' || c.timelineRole === 'reference') return false;
            if (excludeFlashback && c.timelineRole === 'flashback') return false;
            return true;
        })
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    const origCutoffCh = eligibleOriginals.length > 0
        ? eligibleOriginals[eligibleOriginals.length - 1]
        : ((novelData?.chapters || []).find(c => c && Number(c.index) === cutoff) || null);
    const sortedContinued = [...(continuedChapters || [])]
        .filter(c => c && String(c.content || '').trim())
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));

    const latestContinued = sortedContinued.length > 0 ? sortedContinued[sortedContinued.length - 1] : null;
    const anchorCh = latestContinued || origCutoffCh;
    const isFreshStart = !anchorCh && cutoff === 0;
    const prevChapterIndex = anchorCh ? Number(anchorCh.index || cutoff) : cutoff;
    const nextChapterIndex = prevChapterIndex + 1;
    const sampleTitle = origCutoffCh?.title || novelData?.chapters?.[0]?.title || '';
    const chapterUnit = /节\s*$/.test(String(sampleTitle).trim()) ? '节' : '章';

    const cleanBody = anchorCh ? stripNonStoryBlocks(anchorCh.content || '').replace(/<\/?game>/gi, '').trim() : '';
    const tailSnippet = cleanBody.slice(-1400);
    const shortClosing = cleanBody.replace(/\s+/g, ' ').slice(-90);

    return {
        prevChapterIndex,
        nextChapterIndex,
        chapterUnit,
        anchorTitle: isFreshStart ? '新书开篇（从第 1 章起笔）' : (anchorCh?.title || `第 ${prevChapterIndex} ${chapterUnit}`),
        tailSnippet,
        shortClosing,
        isFreshStart,
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
    worldInfoContext = '',
}) {
    const narrativeCfg = ledger?.narrativeConfig || {};
    const excludeFlashback = narrativeCfg.excludeFlashbackFromAnchor !== false;
    const strictPov = narrativeCfg.povMode === 'strict_limited' && Boolean(String(narrativeCfg.povCharacter || '').trim());
    const povChar = strictPov ? String(narrativeCfg.povCharacter).trim() : '';
    const povPersonLabel = narrativeCfg.povPerson === 'first_person'
        ? '第一人称限制视角'
        : (narrativeCfg.povPerson === 'third_limited' ? '第三人称限制视角' : '跟随原著人称的限制视角');
    const anchor = resolveLatestChapterAnchor(novelData, continuedChapters, { excludeFlashback });
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

    const isThirdLimited = strictPov && narrativeCfg.povPerson !== 'first_person';
    const systemPrompt = [
        '你是原著级长篇小说总导演与卷纲/分镜策划，负责把作者给出的简略过程与结果扩写成可直接逐章交给续写模型执笔的【原味分镜导演大纲】。',
        '【绝对铁律】：',
        '1. 严格继承原著的叙事结构与节奏骨相：每章采用多切镜、冷热交替结构（主线推进/日常工作 与 伏笔埋设/对话博弈 穿插），严禁把整章死磕在同一个房间原地水字数！',
        '2. 只写【时间地点、出场人物、客观事件节拍、对话试探焦点、关键信息差、微动作切入点】，严禁在大纲里塞入网文八股情绪形容词（严禁写“邪魅霸道、声音沙哑、喉结滚动、空气仿佛凝固、一丝不易察觉”等词，以免污染下游执笔模型的文风）！',
        '2.5 【反器械黑话与生活化互动铁律】：除非作品设定或作者指令明确要求硬核实验/医疗程序，严禁凭空往大纲里塞入“丁腈手套、金属探针、导电凝胶、阻抗波形、免责条款”等冰冷实验室/体检器械黑话！人物之间的接触、试探、压迫与越界必须落在具体生活场景与真实人际动作中（如倒茶递物、并肩交谈、整理衣领、肢体逼近与微动作交锋），保留活人博弈的温度与张力，严禁写成流水线作业！',
        '3. 每个登场人物的反应与说话方式必须 100% 遵循《核心人物防 OOC 档案》——寡言角色就安排极简短句或沉默动作，松弛狡黠或擅于攻心的角色就写出其散漫带笑、以柔克刚的真实气场，严禁把性格鲜明的人物统统写成面无表情宣读公文的机械人或阴鸷霸总！',
        '4. 若一次规划多章，必须合理拆解节奏与递进层次（起承转合、章末留钩、下章紧接上章结尾，绝不把所有剧情和伏笔堆在第 1 章写完，也不得重复水戏）！',
        ...(strictPov ? [
            `5. 【严格单视角（Limited POV）铁律】：全部分镜必须严格锁定在「${povChar}」的${povPersonLabel}感官、行踪与可达信息范围内！严禁安排「${povChar}既不在场、也无录像/通讯/第三人转述渠道」的他人独处密室镜头；幕后阴谋只能通过「${povChar}」可察觉的破绽、异常数据、人物微反应或收到的信息侧面呈现！${isThirdLimited ? `分镜中指代主角一律使用「${povChar}」或「他/她」，严禁把反身代词「自己」当成独立主语！` : ''}`,
        ] : []),
        ...(narrativeCfg.strictTimelineOrder !== false ? [
            '6. 【时间线单向推进红线】：严禁时间倒流或无新因果地重复规划编年史中已经完成过的同类重大桥段，每一章都必须在最新时间点之后向前推进！',
        ] : []),
        ...(narrativeCfg.referenceTimelineMode ? [
            `6.5 【平行视角 · 严守基准时间线铁律】：你正在以当前视角续写平行线！下方提供了已完结的【${narrativeCfg.referencePovLabel || '基准时间线'}】事件蓝图与进度指针。必须严格按基准时间线的先后顺序推进与补完幕后细节：已走过的基准节点严禁重复再写，前方既定节点（如见面、通话、出行、关键转折）的时间点与对外交集结果必须 100% 严丝合缝，严禁凭空编造与基准时间线矛盾或重复的大事件！`,
        ] : []),
        '7. 严格按要求的 `<chapter_outline index="章号" title="章节简短标题">...</chapter_outline>` 标签输出每一章，不要输出额外寒暄或解释。',
    ].join('\n');

    const bookTitle = String(novelData?.title || ledger?.storyBlueprint?.title || '').trim() || '当前长篇小说';
    const isFreshOriginal = Boolean(anchor.isFreshStart);
    const activeVolume = resolveActiveVolume(ledger?.storyBlueprint, anchor.nextChapterIndex);
    const blueprintBlock = buildStoryBlueprintContextBlock(ledger?.storyBlueprint, anchor.nextChapterIndex, {
        includeNextVolumeGuard: true,
    });

    const parts = [
        `【目标作品】：《${bookTitle}》`,
        isFreshOriginal
            ? (isMulti
                ? `【规划目标】：作为新书开篇，一次性连贯规划 **开篇连续 ${targetChapters} ${anchor.chapterUnit}**（第 1 ~ ${endChapterIndex} ${anchor.chapterUnit}）的分章导演大纲！`
                : `【规划目标】：作为新书开篇，策划【第 1 ${anchor.chapterUnit}】的详细分镜导演大纲（立住核心人物、开场矛盾与钩子）。`)
            : (isMulti
                ? `【规划目标】：紧接【${anchor.anchorTitle}】结尾，一次性连贯规划 **连续 ${targetChapters} ${anchor.chapterUnit}**（第 ${anchor.nextChapterIndex} ~ ${endChapterIndex} ${anchor.chapterUnit}）的分章导演大纲！`
                : `【规划目标】：紧接【${anchor.anchorTitle}】结尾，策划【第 ${anchor.nextChapterIndex} ${anchor.chapterUnit}】的详细分镜导演大纲。`),
        `【规划规格】：每章分 **${targetScenes} 个自然切镜**；整体推进步幅：**${paceDesc}**。${activeVolume ? `当前对应卷纲：第 ${activeVolume.index} 卷《${activeVolume.title}》（${activeVolume.chapterRange}）。` : ''}`,
        '',
        brief
            ? `【作者提供的简略过程与结果（最高剧情指令，必须完整落实${isMulti ? `并合理分配到第 ${anchor.nextChapterIndex}~${endChapterIndex} ${anchor.chapterUnit}中层层递进` : '并自然展开'}，不得擅自改写作者指定的结果）】：\n${brief}`
            : (isFreshOriginal
                ? `【作者未填写具体分章过程】：请严格依据下方《L1 全书总纲与 L2 分卷路线图》、核心人物档案与世界书设定，自主构思一版极具张力与节奏感的开篇第 1~${endChapterIndex} ${anchor.chapterUnit}分镜大纲！`
                : `【作者未填写具体过程】：请基于下方最新结尾、卷纲路线、近期编年史与待填伏笔，自主构思一版最贴合本作走向与节奏的${isMulti ? `连续 ${targetChapters} ${anchor.chapterUnit}` : '下一章'}分镜大纲！`),
    ];

    if (blueprintBlock) {
        parts.push('', blueprintBlock);
    }

    if (anchor.tailSnippet) {
        parts.push(
            '',
            `【上一章（${anchor.anchorTitle}）真实结尾原文（第 ${anchor.nextChapterIndex} ${anchor.chapterUnit}第 1 镜必须无缝承接此处）】：`,
            anchor.tailSnippet,
        );
    }

    const characters = Array.isArray(ledger?.characters) ? ledger.characters : [];
    if (characters.length > 0) {
        parts.push('', '【核心人物灵魂、当前着装与防 OOC 红线（大纲中所有人物行为与衣着必须严格遵守）】：');
        for (const ch of characters.slice(0, 10)) {
            const appearPart = ch.currentAppearance ? ` ｜ 当前外观/着装=${ch.currentAppearance}` : '';
            parts.push(
                `- ${ch.name}${ch.role ? `（${ch.role}）` : ''}：当前处境=${ch.currentSituation || '见前文'}${appearPart} ｜ 真实言行=${ch.voiceAndQuotes || '见原著'} ｜ 🚫OOC红线=${ch.oocRedLines || '严格贴合原著'}`,
            );
        }
    }

    if (worldInfoContext && String(worldInfoContext).trim()) {
        const wiRule = narrativeCfg.worldInfoPriority === 'wi_strict'
            ? '严格遵循世界书中的角色外貌、常服着装与世界观硬设定，不得擅自改穿其他衣服或违背设定'
            : '世界书提供世界观、能力与外貌底骨；若本小说正文已明确改写或剧情换装，则以小说最新状态为准，严禁混搭两套服饰';
        parts.push(
            '',
            `【已激活酒馆世界书设定（${wiRule}）】：`,
            String(worldInfoContext).trim(),
        );
    }

    const allChronicle = Array.isArray(ledger?.chronicle) ? ledger.chronicle : [];
    const refMode = Boolean(narrativeCfg.referenceTimelineMode);
    const refCursor = Number(narrativeCfg.referenceCursorChapter || 0);
    const refLookahead = Math.max(2, Math.min(20, Number(narrativeCfg.referenceLookaheadChapters) || 8));
    const refChapters = (novelData?.chapters || []).filter(c => c && c.timelineRole === 'reference');
    const refChapterSet = new Set(refChapters.map(c => Number(c.index)));
    const isRefEvent = (e) => e && (e.timelinePhase === 'reference' || (refMode && refChapterSet.has(Number(e.startChapter))));

    const mainChronicle = allChronicle.filter(e => e && e.timelinePhase !== 'flashback' && !isRefEvent(e)).slice(-12);
    const refChronicle = refMode ? allChronicle.filter(isRefEvent).sort((a, b) => (a.startChapter || 0) - (b.startChapter || 0)) : [];
    const flashbackChronicle = allChronicle.filter(e => e && e.timelinePhase === 'flashback').slice(-6);

    if (refMode) {
        const refLabel = narrativeCfg.referencePovLabel || '已完结基准时间线';
        const doneRefEvts = refChronicle.filter(e => refCursor > 0 && Number(e.endChapter || e.startChapter || 0) <= refCursor);
        const upcomingRefEvts = refChronicle.filter(e => {
            const st = Number(e.startChapter || 0);
            const ed = Number(e.endChapter || st);
            return ed > refCursor && st <= refCursor + refLookahead;
        });
        const upcomingRefChapters = refChapters
            .filter(c => Number(c.index) > refCursor && Number(c.index) <= refCursor + Math.min(4, refLookahead))
            .sort((a, b) => Number(a.index) - Number(b.index));

        parts.push(
            '',
            `【🧭 平行视角 · ${refLabel}对照路标（当前已对齐至基准第 ${refCursor} 章 · 接下来必须按序衔接第 ${refCursor + 1}~${refCursor + refLookahead} 章）】`,
        );
        if (doneRefEvts.length > 0) {
            parts.push(`▸ ✅ 基准时间线已完成节点（#${doneRefEvts[0].startChapter}~#${refCursor}，严禁重复再写）：${doneRefEvts.map(e => `${e.chapterRange}${e.title}`).join(' → ')}`);
        }
        if (upcomingRefEvts.length > 0) {
            parts.push('▸ 🎯 接下来必须按顺序衔接与补完的基准时间线节点（严禁跳序、严禁凭空多加同类大事件）：');
            for (const evt of upcomingRefEvts) {
                parts.push(`  - (${evt.chapterRange}) ${evt.title}：${evt.summary}`);
            }
        }
        if (upcomingRefChapters.length > 0) {
            parts.push('▸ 📄 基准时间线前方原著摘要（供核对精确时间、地点、对话与交集细节）：');
            for (const ch of upcomingRefChapters) {
                const body = stripNonStoryBlocks(ch.content || '').replace(/\s+/g, ' ').trim();
                parts.push(`  - [基准#${ch.index} ${ch.title}]：${body.slice(0, 420)}${body.length > 420 ? '……' : ''}`);
            }
        }
    }
    if (mainChronicle.length > 0) {
        parts.push('', strictPov
            ? `【主线近期编年史（已发生且不可重复；仅「${povChar}已知」可直接入镜）】：`
            : '【近期剧情编年史与现有信息差（已发生的重大节点严禁重复规划）】：');
        for (const evt of mainChronicle) {
            const knownPart = strictPov && evt.povKnown ? ` ｜ ${povChar}已知：${evt.povKnown}` : '';
            const blindPart = strictPov && evt.povBlindspot ? ` ｜ 🔒幕后盲区（不可直接切视角写）：${evt.povBlindspot}` : '';
            const gapPart = (!knownPart && !blindPart && evt.infoGap) ? ` ｜ 信息差：${evt.infoGap}` : '';
            parts.push(`- (${evt.chapterRange}) ${evt.title}：${evt.summary}${knownPart}${blindPart}${gapPart}`);
        }
    }
    if (flashbackChronicle.length > 0) {
        parts.push('', strictPov
            ? `【🔒 倒叙/他视角幕后逻辑黑盒（仅供维持逻辑一致性参考，严禁切去写「${povChar}」看不到的独处镜头，也严禁让「${povChar}」未卜先知）】：`
            : '【倒叙/补完视角参考（时间已属过去，勿当成最新时间点往回倒退）】：');
        for (const evt of flashbackChronicle) {
            parts.push(`- (${evt.chapterRange}·倒叙/他视角) ${evt.title}：${evt.summary}`);
        }
    }

    // Zero-API continuous bridge covering ALL unarchived original main chapters & ALL continued chapters up to anchor!
    const unarchivedBridge = buildUnarchivedRecentChaptersBridge({
        novelData,
        continuedChapters,
        ledger,
        upToChapterIndex: anchor.prevChapterIndex,
        excludeFlashback,
        maxItems: 22,
    });
    if (unarchivedBridge.count > 0) {
        parts.push(
            '',
            `【📌 尚未并入编年史的最新已写章节实录（第 ${unarchivedBridge.startChapter}~${unarchivedBridge.endChapter} ${anchor.chapterUnit} · 这些剧情均已真实发生，严禁失忆重演、严禁凭空编造与以下进展冲突的设定或人物！）】：`,
            ...unarchivedBridge.lines,
        );
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
    if (sp?.fingerprintText || sp?.styleCard || sp?.goldenExcerpts) {
        parts.push('', '【原著文风与节奏骨相参考（确保分镜节奏与原作者习惯一致）】：');
        if (sp.fingerprintText) parts.push(sp.fingerprintText);
        if (sp.styleCard) {
            const cleanCard = sanitizeStyleCardText(sp.styleCard);
            if (cleanCard) parts.push(cleanCard.slice(0, 1200));
        }
        if (sp.goldenExcerpts) {
            parts.push('', '【原著活样本范例（大纲对话焦点与微动作切入点须严格对齐此种质感与口吻）】：', String(sp.goldenExcerpts).slice(0, 1200));
        }
    }

    const perChapterBudget = targetChapters >= 5 ? '220 ~ 360 字' : '280 ~ 480 字';
    parts.push(
        '',
        `请严格输出 **${targetChapters} 个** \`<chapter_outline index="章号" title="章节简短标题">...</chapter_outline>\` 标签块（从第 ${anchor.nextChapterIndex} ${anchor.chapterUnit}到第 ${endChapterIndex} ${anchor.chapterUnit}，直接输出尖括号标签不要加反引号，每章独立完整、可直接复制发给 AI 续写，每章约 ${perChapterBudget}）：`,
        `- 起始标签写法：\`<chapter_outline index="${anchor.nextChapterIndex}" title="第 ${anchor.nextChapterIndex} ${anchor.chapterUnit} · 简短标题">\``,
        `- 块内正文结构：`,
        `  【第 ${anchor.nextChapterIndex} ${anchor.chapterUnit} 导演分镜大纲（承接：${anchor.anchorTitle}）】`,
        `  1. （时间·地点·镜头定位）具体客观事件、对话试探焦点、信息差...`,
        `  2. （切镜转场·时间·地点）...`,
        `  ...（共 ${targetScenes} 个清晰镜头，冷热交替，最后一个镜头给出收尾定格并自然引出下一章）`,
        '  【本章执笔纪律】',
        '  - 严格复刻原著短段骨相与切镜节奏，不原地水字数、不写网文八股形容词；',
        '  - （针对本章人物反应边界与“暂不摊牌”的精准控制要求）',
        '- 结束标签写法：`</chapter_outline>`',
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
    worldInfoContext = '',
    callModel,
    signal = null,
}) {
    throwIfAborted(signal);
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
        worldInfoContext,
    });

    const raw = await callModel({
        stage: targetChapters > 1 ? `director_outline_arc_${targetChapters}ch` : 'director_outline_generate',
        systemPrompt,
        prompt,
    });
    throwIfAborted(signal);

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

function extractBlueprintTag(text, tag) {
    const m = String(text || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : '';
}

function isEmptyBlueprintPlaceholder(val) {
    const s = String(val || '').trim();
    return !s || /^(?:无|暂无|none|n\/a|-|—|省略)$/i.test(s);
}

/**
 * Builds the unified L1 Master Blueprint + L2 Volume Roadmap + Initial 4-Dim Characters + Initial Hooks prompt.
 * Supports BOTH a 1-sentence brainwave (expanded via creativity + WorldInfo) AND a large pasted
 * worldbuilding/character draft (faithfully structured without overwriting author facts).
 */
export function buildMasterBlueprintPrompt({
    title = '',
    creationMode = 'original', // 'original' | 'fanfic_new' | 'continuation'
    genreAndTone = '',
    seedNotes = '',
    volumeCount = 4,
    chaptersPerVolume = 15,
    startChapter = 1,
    narrativeConfig = null,
    worldInfoContext = '',
    novelData = null,
    existingLedger = null,
} = {}) {
    const targetVols = Math.max(2, Math.min(8, Number(volumeCount) || 4));
    const perVol = Math.max(5, Math.min(50, Number(chaptersPerVolume) || 15));
    const startCh = Math.max(1, Number(startChapter) || 1);
    const modeDesc = creationMode === 'original'
        ? '原创世界观长篇小说（从零开新书）'
        : (creationMode === 'fanfic_new' ? '同人新开坑长篇小说（依托原作世界书/设定从第 1 章起笔）' : '长篇续写后续卷纲规划');
    const strictPov = narrativeConfig?.povMode === 'strict_limited' && Boolean(String(narrativeConfig?.povCharacter || '').trim());
    const povChar = strictPov ? String(narrativeConfig.povCharacter).trim() : '';
    const hasSeed = Boolean(String(seedNotes || '').trim());
    const isLargeDraft = String(seedNotes || '').trim().length >= 300;

    const systemPrompt = [
        '你是顶级长篇小说总策划与结构架构师，负责为作者建立【逻辑严密、冲突清晰、分卷递进、人物立体不 OOC】的全书 L1 总纲、L2 分卷路线图、初始核心人物 4 维档案与长线伏笔总账。',
        '【核心策划纪律】：',
        '1. 若作者提供了详细的设定草稿或世界书，必须 100% 忠实拆解并吸收其中的人物、势力、能力规则与既定因果，绝不擅自篡改作者原设；若作者只给了简短脑洞，则顺着其核心看点补全扎实的因果链与人物动机。',
        '2. 每一卷（L2）必须有独立且递进的核心矛盾、清晰的中段转折与卷末高潮，各卷之间严禁原地重复套路；预计章号区间必须连续衔接。',
        '3. 核心人物必须有独立立场、私心顾虑、说话方式特征与防 OOC 红线，拒绝工具人化、拒绝贴标签式的扁平人设。',
        ...(strictPov ? [`4. 本书锁定「${povChar}」严格单视角（Limited POV），所有主线推进与伏笔揭晓必须规划为可通过「${povChar}」的所见所闻逐步触达。`] : []),
        '5. 严格按要求的 XML 标签输出，不要输出寒暄、开场白或额外解释。',
    ].join('\n');

    const parts = [
        `【策划类型】：${modeDesc}`,
        title ? `【暂定书名】：《${title}》` : '【暂定书名】：尚未命名（请根据题材给出一个有质感、不俗套的书名）',
        genreAndTone ? `【题材与基调】：${genreAndTone}` : '',
        `【分卷规划规模】：规划 **${targetVols} 卷**（从第 ${startCh} 章起，每卷约 ${perVol} 章，可按剧情体量自然微调起止章号）。`,
        '',
        hasSeed
            ? (isLargeDraft
                ? `【作者提供的完整世界观 / 人设 / 剧情草稿（最高设定权威——请完整拆解、结构化并补齐分卷节拍，严禁遗漏核心人物与设定）】：\n${String(seedNotes).trim().slice(0, 14000)}`
                : `【作者提供的核心脑洞与开篇想法（最高创意指令——请以此为核心展开成完整的全书总纲、分卷路线、核心人物与伏笔）】：\n${String(seedNotes).trim()}`)
            : '【作者未填额外草稿】：请结合下方已激活酒馆世界书、现有剧情与人物信息，规划一份完整可落地的全书总纲与分卷路线图！',
    ].filter(Boolean);

    if (worldInfoContext && String(worldInfoContext).trim()) {
        parts.push(
            '',
            '【已激活酒馆世界书设定（世界观底骨、人物外貌/能力与势力规则必须严格贴合此处）】：',
            String(worldInfoContext).trim(),
        );
    }

    const existingChronicle = (existingLedger?.chronicle || []).slice(-10);
    if (existingChronicle.length > 0) {
        parts.push('', '【已有前文剧情编年史（后续卷纲必须承接此处，不可推翻重写）】：');
        for (const e of existingChronicle) {
            parts.push(`- (${e.chapterRange}) ${e.title}：${e.summary}`);
        }
    } else if (novelData?.chapters?.length > 0) {
        parts.push('', `【已导入原著进度】：《${novelData.title}》共 ${novelData.totalChapters} 章，当前锚点第 ${novelData.cutoffChapterIndex} 章。`);
    }

    const existingChars = (existingLedger?.characters || []).slice(0, 10);
    if (existingChars.length > 0) {
        parts.push('', '【已有核心人物档案（请在输出中保留并按需要补充新登场核心角色）】：');
        for (const c of existingChars) {
            parts.push(`- ${c.name}${c.role ? `（${c.role}）` : ''}：${c.currentSituation || c.canonFoundation || ''}`);
        }
    }

    const vol1End = startCh + perVol - 1;
    parts.push(
        '',
        '严格按以下 4 个顶级 XML 块输出完整立项蓝图（直接输出尖括号标签不要加反引号）：',
        '- 块 1：`<book_blueprint>` …… `</book_blueprint>`（内部依次包含以下单行子标签）：',
        `  · \`<title>${title || '作品正式书名'}</title>\``,
        '  · `<genre_tone>题材定位、叙事基调与核心看点（1~2句）</genre_tone>`',
        '  · `<premise>250~500字全书总纲：核心开端事件、主线驱动矛盾、主角成长/变化弧线与多线交织脉络</premise>`',
        '  · `<world_rules>世界观硬规则、力量/社会/机构运作体系与创作不可违背的逻辑底线（150~350字）</world_rules>`',
        '  · `<ending_direction>全书终局方向、最终高潮核心冲突与主题收束（100~220字）</ending_direction>`',
        `- 块 2：\`<volumes>\` …… \`</volumes>\`（按推进顺序输出 **${targetVols} 卷**；每卷以 \`<volume>\` 开头、\`</volume>\` 结尾，内部依次包含）：`,
        '  · `<title>本卷简短有力的卷名（不含“第X卷”前缀）</title>`',
        `  · \`<chapters>第 ${startCh}~${vol1End} 章</chapters>\``,
        '  · `<goal>本卷核心目标、主要矛盾与舞台背景（80~160字）</goal>`',
        '  · `<key_turns>本卷 3~5 个关键转折、中段冲突升级与卷末高潮节点（120~240字）</key_turns>`',
        '  · `<ending_hook>本卷结尾定格画面与引向下一卷的核心悬念（50~100字）</ending_hook>`',
        '- 块 3：`<characters>` …… `</characters>`（输出 **3~8 位**核心人物；每位以 `<character>` 开头、`</character>` 结尾，内部依次包含）：',
        '  · `<name>人物姓名</name>`',
        '  · `<role>核心身份与在主线中的位置</role>`',
        '  · `<canon_foundation>能力体系、出身履历、世界观/原作底骨与深层动机</canon_foundation>`',
        '  · `<current_appearance>稳定外貌特征与开篇常服/配饰锚点</current_appearance>`',
        '  · `<current_situation>开篇/当前所处境地、手里筹码、弱点与对主角/他人的初始态度</current_situation>`',
        '  · `<voice_and_quotes>说话长短习惯、语气口癖、微动作特征 + 2 句示范性原味台词</voice_and_quotes>`',
        '  · `<ooc_red_lines>绝对 OOC 红线（明确列出 2~3 个绝不能写崩的雷区）</ooc_red_lines>`',
        '- 块 4：`<hooks>` …… `</hooks>`（列出 **5~10 条**贯穿全书与前两卷的核心伏笔/暗线，每条一行：`[新伏笔] 具体伏笔内容 (#预计埋下章号)`）',
    );

    return { systemPrompt, prompt: parts.join('\n') };
}

/**
 * Deterministically parses L1 Blueprint, L2 Volumes, initial 4-Dim Characters, and initial Hooks.
 */
export function parseMasterBlueprintResponse(rawText, {
    creationMode = 'original',
    fallbackTitle = '',
    fallbackGenre = '',
    seedNotes = '',
    startChapter = 1,
} = {}) {
    const cleaned = cleanDistillProse(rawText);
    const bpInner = extractBlueprintTag(cleaned, 'book_blueprint') || cleaned;
    const title = extractBlueprintTag(bpInner, 'title').replace(/^[《「『]+|[》」』]+$/g, '').trim() || String(fallbackTitle || '').trim();
    const genreAndTone = extractBlueprintTag(bpInner, 'genre_tone') || String(fallbackGenre || '').trim();
    const premise = extractBlueprintTag(bpInner, 'premise');
    const worldRules = extractBlueprintTag(bpInner, 'world_rules');
    const endingDirection = extractBlueprintTag(bpInner, 'ending_direction');

    const volumesInner = extractBlueprintTag(cleaned, 'volumes') || cleaned;
    const volumes = [];
    const volRegex = /<volume>([\s\S]*?)<\/volume>/gi;
    let m;
    let cursor = Math.max(1, Number(startChapter) || 1);
    while ((m = volRegex.exec(volumesInner)) !== null) {
        const block = m[1];
        const idx = volumes.length + 1;
        const vTitle = extractBlueprintTag(block, 'title').replace(/^第\s*\d+\s*卷[\s·：:.\-]*/, '').trim() || `第 ${idx} 卷`;
        const rangeRaw = extractBlueprintTag(block, 'chapters');
        const nums = [...rangeRaw.matchAll(/\d+/g)].map(n => Number(n[0])).filter(n => n > 0);
        const startCh = nums[0] || cursor;
        const endCh = nums[nums.length - 1] >= startCh ? nums[nums.length - 1] : (startCh + 14);
        cursor = endCh + 1;
        volumes.push({
            id: `vol_${idx}_${Date.now().toString(36)}`,
            index: idx,
            title: vTitle,
            chapterRange: rangeRaw || `第 ${startCh}~${endCh} 章`,
            startChapter: startCh,
            endChapter: endCh,
            goal: extractBlueprintTag(block, 'goal'),
            keyTurns: extractBlueprintTag(block, 'key_turns'),
            endingHook: extractBlueprintTag(block, 'ending_hook'),
            status: idx === 1 ? 'active' : 'planned',
            recap: '',
            recapCheck: '',
            recapUpdatedAt: 0,
        });
    }

    const characters = parseCharacterProfiles(cleaned, Math.max(1, Number(startChapter) || 1));

    const hooksInner = extractBlueprintTag(cleaned, 'hooks');
    const hooks = [];
    if (hooksInner) {
        const lines = hooksInner.split('\n').map(l => l.replace(/^[\s\-*•·\d.、]+/, '').trim()).filter(Boolean);
        for (const line of lines) {
            if (isEmptyBlueprintPlaceholder(line)) continue;
            const chMatch = line.match(/\(#?第?\s*(\d+)\s*章?\)\s*$/);
            const plantedChapter = chMatch ? Number(chMatch[1]) : Math.max(1, Number(startChapter) || 1);
            const content = line
                .replace(/^[\[【]?(?:新伏笔|待填|伏笔|暗线|open)[\]】]?[:：\s\-—]*/i, '')
                .replace(/\(#?第?\s*\d+\s*章?\)\s*$/, '')
                .trim();
            if (!isEmptyBlueprintPlaceholder(content)) {
                hooks.push({
                    id: `hook_bp_${Date.now().toString(36)}_${hooks.length + 1}`,
                    content,
                    plantedChapter,
                    autoExtracted: true,
                    status: 'open',
                });
            }
        }
    }

    return {
        blueprint: {
            creationMode,
            title,
            genreAndTone,
            seedNotes: String(seedNotes || '').trim(),
            premise,
            worldRules,
            endingDirection,
            volumes,
            updatedAt: Date.now(),
        },
        characters,
        hooks,
    };
}

/**
 * Generates L1 Master Blueprint + L2 Volume Roadmap + Initial Characters + Initial Hooks in 1 API call.
 */
export async function generateMasterBlueprint({
    title = '',
    creationMode = 'original',
    genreAndTone = '',
    seedNotes = '',
    volumeCount = 4,
    chaptersPerVolume = 15,
    startChapter = 1,
    narrativeConfig = null,
    worldInfoContext = '',
    novelData = null,
    existingLedger = null,
    callModel,
    signal = null,
}) {
    throwIfAborted(signal);
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }
    if (!String(seedNotes || '').trim() && !String(worldInfoContext || '').trim() && !novelData?.chapters?.length && !existingLedger?.chronicle?.length) {
        throw new Error('请先输入核心脑洞/世界观人设草稿（或挂载已激活的酒馆世界书）后再生成总纲');
    }

    const { systemPrompt, prompt } = buildMasterBlueprintPrompt({
        title,
        creationMode,
        genreAndTone,
        seedNotes,
        volumeCount,
        chaptersPerVolume,
        startChapter,
        narrativeConfig,
        worldInfoContext,
        novelData,
        existingLedger,
    });

    const raw = await callModel({
        stage: 'master_blueprint_generate',
        systemPrompt,
        prompt,
    });
    throwIfAborted(signal);

    const cleanedRaw = cleanDistillProse(raw);
    const hasBlueprintTags = /<(?:book_blueprint|volumes|volume)\b/i.test(cleanedRaw);
    if (!hasBlueprintTags && isModelRefusalText(cleanedRaw)) {
        throw new Error(`模型返回了拒答/道歉内容（未覆盖现有总纲）：${cleanedRaw.slice(0, 120)}`);
    }

    const parsed = parseMasterBlueprintResponse(raw, {
        creationMode,
        fallbackTitle: title || novelData?.title || '',
        fallbackGenre: genreAndTone,
        seedNotes,
        startChapter,
    });
    if (!hasStoryBlueprintData(parsed.blueprint) && parsed.blueprint.volumes.length === 0) {
        throw new Error('未能解析出有效的全书总纲或分卷规划，请检查模型/预设后重试');
    }
    return parsed;
}
