/**
 * Bounded-Concurrency (max <= 2) Multi-Round Iterative Adversarial Style Distillation Pipeline
 * for the Novel Continuation extension.
 *
 * Architecture:
 *   Stage 0 (Local, 0 API): Objective statistical fingerprint + non-overlapping train (A/B/C) & 3 unseen holdouts (H1/H2/H3)
 *   Stage 1 (2-way parallel): 1A Deep syntax/POV/sensory/scale anatomy || 1B Dialogue/character-voice/4 multi-scene Golden Excerpts
 *   Stage 2 (2-way parallel): 2A Merge Deep Draft Style Bible (1800~2600 chars) || 2B Strip Holdout #1 into dry event outline
 *   Iterative Adversarial Loop (Round 1 .. N, default 2 rounds, configurable 1~3, early-stop if score >= 92):
 *     - Blind Rewrite: Rewrite unseen holdout's dry outline using ONLY current Style Bible + Golden Excerpts
 *     - Forensic Judge & Patch: Compare Original Truth vs Blind Rewrite side-by-side -> 0~100 similarity score + diff report + patched Deep Style Bible
 *   Also supports 1-click Incremental Refinement (+1 extra blind-test round on an existing/edited Style Bible).
 */

import { stripNonStoryBlocks } from './parser.js';

/**
 * Runs an array of async task factories with strict bounded concurrency (`<= maxConcurrency`).
 *
 * @template T
 * @param {Array<() => Promise<T>>} taskFns
 * @param {number} [maxConcurrency=2]
 * @returns {Promise<T[]>}
 */
export async function runBoundedPool(taskFns, maxConcurrency = 2) {
    const limit = Math.max(1, Math.min(2, Number(maxConcurrency) || 2));
    const results = new Array(taskFns.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < taskFns.length) {
            const current = nextIndex;
            nextIndex += 1;
            results[current] = await taskFns[current]();
        }
    }

    const workers = Array.from({ length: Math.min(limit, taskFns.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

/**
 * Computes objective, deterministic statistical style metrics from chapters `1 .. cutoffChapterIndex`.
 * Zero API calls, zero hallucination.
 *
 * @param {Array<{ index: number, title: string, content: string }>} chapters
 * @param {number} cutoffChapterIndex
 */
export function computeLocalStyleFingerprint(chapters, cutoffChapterIndex) {
    const allowed = (chapters || []).filter(
        c => c && c.index >= 1 && (!cutoffChapterIndex || c.index <= cutoffChapterIndex),
    );
    const fullText = allowed.map(c => String(c.content || '')).join('\n\n').trim();
    const compact = fullText.replace(/\s+/g, '');
    const totalChars = compact.length;

    if (totalChars === 0) {
        return {
            totalChars: 0,
            paragraphCount: 0,
            avgParagraphChars: 0,
            avgSentenceChars: 0,
            shortSentenceRatio: 0,
            dialogueRatio: 0,
            avgDialogueChars: 0,
            povHint: '未知',
            punctuationPer1k: {},
        };
    }

    const paragraphs = fullText
        .split(/\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0 && !/^[-=_*]{4,}$/.test(p));
    const avgParagraphChars = Math.round(totalChars / Math.max(1, paragraphs.length));

    const sentences = fullText
        .split(/[。！？!?\n]+/)
        .map(s => s.replace(/\s+/g, ''))
        .filter(s => s.length >= 2);
    const sentenceCharSum = sentences.reduce((acc, s) => acc + s.length, 0);
    const avgSentenceChars = Math.round(sentenceCharSum / Math.max(1, sentences.length));
    const shortSentenceCount = sentences.filter(s => s.length <= 15).length;
    const shortSentenceRatio = Math.round((shortSentenceCount / Math.max(1, sentences.length)) * 100);

    const dialogueMatches = [...fullText.matchAll(/[“「『"]([^”」』"\n]{1,300})[”」』"]/g)];
    const dialogueCharSum = dialogueMatches.reduce((acc, m) => acc + m[1].replace(/\s+/g, '').length, 0);
    const dialogueRatio = Math.min(100, Math.round((dialogueCharSum / totalChars) * 100));
    const avgDialogueChars = dialogueMatches.length > 0
        ? Math.round(dialogueCharSum / dialogueMatches.length)
        : 0;

    const narrationOnly = fullText.replace(/[“「『"][^”」』"\n]{1,300}[”」』"]/g, '');
    const firstPersonHits = (narrationOnly.match(/我/g) || []).length;
    const thirdPersonHits = (narrationOnly.match(/[他她]/g) || []).length;
    let povHint = '第三人称';
    if (firstPersonHits > thirdPersonHits * 1.35 && firstPersonHits >= 8) {
        povHint = '第一人称（“我”视角）';
    } else if (firstPersonHits > 5 && thirdPersonHits > 5 && Math.abs(firstPersonHits - thirdPersonHits) < Math.max(firstPersonHits, thirdPersonHits) * 0.3) {
        povHint = '混合/切换视角';
    }

    const per1k = (pattern) => Number((((fullText.match(pattern) || []).length / totalChars) * 1000).toFixed(1));
    const punctuationPer1k = {
        ellipsis: per1k(/……|\.{3,}/g),
        dash: per1k(/——/g),
        exclamation: per1k(/[！!]/g),
        question: per1k(/[？?]/g),
        tilde: per1k(/[～~]/g),
        heart: per1k(/[❤♡♥]/g),
    };

    return {
        totalChars,
        paragraphCount: paragraphs.length,
        avgParagraphChars,
        avgSentenceChars,
        shortSentenceRatio,
        dialogueRatio,
        avgDialogueChars,
        povHint,
        punctuationPer1k,
    };
}

/**
 * Formats a local style fingerprint into a compact Chinese prompt block.
 * @param {ReturnType<typeof computeLocalStyleFingerprint>} fp
 */
export function formatFingerprintText(fp) {
    if (!fp || !fp.totalChars) return '';
    const p = fp.punctuationPer1k || {};
    const marks = [
        `省略号……(${p.ellipsis ?? 0}/千字)`,
        `破折号——(${p.dash ?? 0}/千字)`,
        `感叹号！(${p.exclamation ?? 0}/千字)`,
        `波浪号～(${p.tilde ?? 0}/千字)`,
    ];
    if ((p.heart ?? 0) > 0) {
        marks.push(`爱心符号❤/♡(${p.heart}/千字)`);
    }
    return [
        `- 叙事人称倾向：${fp.povHint}`,
        `- 段落与句长：平均每段 ${fp.avgParagraphChars} 字，平均每句 ${fp.avgSentenceChars} 字（≤15字短句占比 ${fp.shortSentenceRatio}%）`,
        `- 对话密度：对话占比约 ${fp.dialogueRatio}%，平均单句台词 ${fp.avgDialogueChars} 字`,
        `- 标点语气频次：${marks.join('、')}`,
    ].join('\n');
}

/**
 * Splits chapters `1 .. cutoffChapterIndex` into non-overlapping training samples (A, B, C)
 * and up to 3 distinct unseen holdout ground-truth excerpts (`holdouts`) for multi-round blind testing.
 *
 * @param {Array<{ index: number, title: string, content: string }>} chapters
 * @param {number} cutoffChapterIndex
 */
export function selectDistillationSamples(chapters, cutoffChapterIndex) {
    const allowed = (chapters || [])
        .filter(c => c && c.index >= 1 && (!cutoffChapterIndex || c.index <= cutoffChapterIndex))
        .sort((a, b) => a.index - b.index);

    if (allowed.length === 0) {
        return { sampleA: '', sampleB: '', sampleC: '', holdouts: [], holdoutTruth: '', holdoutLabel: '' };
    }

    const cleanBody = (ch) => String(ch.content || '')
        .replace(/^-{4,}[\s\S]{0,220}?-{4,}\s*/m, '')
        .trim();

    if (allowed.length === 1) {
        const text = cleanBody(allowed[0]);
        const len = text.length;
        const cut1 = Math.floor(len * 0.35);
        const cut2 = Math.floor(len * 0.65);
        const holdoutText = text.slice(cut1, Math.min(cut2, cut1 + 1100)).trim() || text.slice(0, 900);
        const holdouts = [{ label: `${allowed[0].title}·中段真迹`, text: holdoutText }];
        return {
            sampleA: `【${allowed[0].title}·前段】\n${text.slice(0, Math.min(cut1, 2400))}`,
            sampleB: `【${allowed[0].title}·后段】\n${text.slice(cut2, Math.min(len, cut2 + 2400))}`,
            sampleC: '',
            holdouts,
            holdoutTruth: holdouts[0].text,
            holdoutLabel: holdouts[0].label,
        };
    }

    if (allowed.length === 2) {
        const c0 = cleanBody(allowed[0]);
        const c1 = cleanBody(allowed[1]);
        const mid0 = Math.floor(c0.length * 0.52);
        const mid1 = Math.floor(c1.length * 0.45);
        const h1 = c0.slice(mid0, Math.min(c0.length, mid0 + 1050)).trim() || c0.slice(-900);
        const h2 = c1.slice(0, Math.min(mid1, 1050)).trim() || c1.slice(0, 900);
        const holdouts = [
            { label: `${allowed[0].title}·后段真迹`, text: h1 },
            { label: `${allowed[1].title}·前段真迹`, text: h2 },
        ];
        return {
            sampleA: `【${allowed[0].title}·前段】\n${c0.slice(0, Math.min(mid0, 2600))}`,
            sampleB: `【${allowed[1].title}·后段】\n${c1.slice(mid1, Math.min(c1.length, mid1 + 2600))}`,
            sampleC: '',
            holdouts,
            holdoutTruth: holdouts[0].text,
            holdoutLabel: holdouts[0].label,
        };
    }

    // 3+ chapters: reserve 1..3 distinct holdout chapters/slices that do not overlap sampleA/sampleB/sampleC
    const n = allowed.length;
    const earlyCh = allowed[0];
    const latestCh = allowed[n - 1];

    const holdoutIndices = new Set();
    const pickHoldoutIdx = (ratio) => {
        const idx = Math.max(1, Math.min(n - 2, Math.floor(n * ratio)));
        holdoutIndices.add(idx);
        return idx;
    };

    const hIdx1 = pickHoldoutIdx(0.5);
    if (n >= 5) pickHoldoutIdx(0.28);
    if (n >= 7) pickHoldoutIdx(0.75);

    const holdouts = [...holdoutIndices].map((idx, order) => {
        const ch = allowed[idx];
        const body = cleanBody(ch);
        const start = body.length > 1500 ? Math.floor(body.length * 0.25) : 0;
        return {
            label: `${ch.title}·盲测真迹 #${order + 1}`,
            text: body.slice(start, start + 1150).trim(),
        };
    });

    // Ensure at least 2 distinct holdouts even for a 3-chapter novel by slicing another region of hIdx1
    if (holdouts.length === 1) {
        const ch = allowed[hIdx1];
        const body = cleanBody(ch);
        if (body.length > 1800) {
            const start2 = Math.floor(body.length * 0.62);
            holdouts.push({
                label: `${ch.title}·盲测真迹 #2`,
                text: body.slice(start2, start2 + 1100).trim(),
            });
        }
    }

    const sampleAParts = [`【${earlyCh.title}】\n${cleanBody(earlyCh).slice(0, 2800)}`];
    const sampleBParts = [`【${latestCh.title}（夺舍节点）】\n${cleanBody(latestCh).slice(-2800)}`];
    const sampleCParts = [];

    // Pick up to 2 additional non-holdout chapters across the middle of the book for richer coverage
    const candidateTrainIndices = [
        Math.floor(n * 0.18),
        Math.floor(n * 0.62),
        Math.floor(n * 0.85),
    ].filter(i => i > 0 && i < n - 1 && !holdoutIndices.has(i));

    const uniqueTrain = [...new Set(candidateTrainIndices)].slice(0, 2);
    for (const idx of uniqueTrain) {
        const ch = allowed[idx];
        sampleCParts.push(`【${ch.title}·节选】\n${cleanBody(ch).slice(0, 2200)}`);
    }

    return {
        sampleA: sampleAParts.join('\n\n'),
        sampleB: sampleBParts.join('\n\n'),
        sampleC: sampleCParts.join('\n\n'),
        holdouts,
        holdoutTruth: holdouts[0]?.text || '',
        holdoutLabel: holdouts[0]?.label || '',
    };
}

/**
 * Extracts text inside `<tag>...</tag>` after stripping thinking/CoT blocks.
 * Falls back to the full stripped text when tags are absent.
 *
 * @param {string} rawText
 * @param {string} tagName
 * @returns {string}
 */
export function extractTaggedSection(rawText, tagName) {
    const cleaned = stripNonStoryBlocks(rawText);
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = cleaned.match(regex);
    if (match && match[1].trim()) {
        return match[1].trim();
    }
    return cleaned.trim();
}

/**
 * Parses a numeric 0..100 fidelity score from `<score>...</score>`.
 * @param {string} rawText
 * @returns {number | null}
 */
export function extractFidelityScore(rawText) {
    const cleaned = stripNonStoryBlocks(rawText);
    const tagMatch = cleaned.match(/<score>([\s\S]*?)<\/score>/i);
    const source = tagMatch ? tagMatch[1] : cleaned;
    const numMatch = source.match(/(\d{1,3})\s*(?:\/\s*100|分)?/);
    if (!numMatch) return null;
    const val = Number(numMatch[1]);
    if (!Number.isFinite(val)) return null;
    return Math.max(0, Math.min(100, val));
}

/**
 * Executes the multi-round bounded-concurrency (<= 2) adversarial style distillation pipeline,
 * or runs +1 incremental blind-test refinement round on an `existingProfile`.
 *
 * @param {{
 *   novelData: { title: string, cutoffChapterIndex: number, totalChapters: number, chapters: Array<{ index: number, title: string, content: string }> },
 *   callModel: (args: { prompt: string, systemPrompt: string, stage: string }) => Promise<string>,
 *   maxConcurrency?: number,
 *   rounds?: number,
 *   existingProfile?: any,
 *   onProgress?: (info: { step: number, totalSteps: number, label: string }) => void,
 * }} params
 */
export async function runStyleDistillationPipeline({
    novelData,
    callModel,
    maxConcurrency = 2,
    rounds = 2,
    existingProfile = null,
    onProgress = () => {},
}) {
    if (!novelData?.chapters?.length) {
        throw new Error('请先导入原著小说后再进行文风蒸馏');
    }
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }

    const cutoff = Number(novelData.cutoffChapterIndex || novelData.totalChapters);
    const concurrency = Math.max(1, Math.min(2, Number(maxConcurrency) || 2));
    const targetRounds = Math.max(1, Math.min(3, Number(rounds) || 2));
    const isIncremental = Boolean(existingProfile?.styleCard);

    const totalSteps = isIncremental ? 2 : (2 + targetRounds * 2);
    let currentStep = 0;

    const fingerprint = existingProfile?.fingerprint || computeLocalStyleFingerprint(novelData.chapters, cutoff);
    const fingerprintText = existingProfile?.fingerprintText || formatFingerprintText(fingerprint);
    const samples = selectDistillationSamples(novelData.chapters, cutoff);

    if (!samples.sampleA || samples.holdouts.length === 0) {
        throw new Error('原著文本过短，无法切分训练样本与盲测真迹样本');
    }

    const analystSystem = '你是一位顶尖文学编辑与法医级文风分析师。你严禁输出“文笔细腻、描写生动、节奏紧凑”这类空泛形容词，必须输出详尽、具体、可量化、附带原著实句对照的深度写作圣经。';
    const outlineSystem = '你是剧情梗概提炼员。你的任务是把一段小说原文剥光一切文风、修辞、心理修饰和原句措辞，只还原成 3~5 句极度干瘪、客观、白开水般的“事件清单”，用于后续盲测仿写。';
    const ghostwriterSystem = '你是一位小说代笔作者。请严格遵照给定的《原著文风 DNA 圣经》和《原著灵魂活样本》的笔触、节奏、标点和尺度，将干瘪事件大纲扩写成 800~1000 字的小说正文。直接输出正文，切勿解释。';

    let currentStyleCard = existingProfile?.styleCard || '';
    let goldenExcerpts = existingProfile?.goldenExcerpts || '';
    const roundHistory = Array.isArray(existingProfile?.roundHistory) ? [...existingProfile.roundHistory] : [];
    const preStrippedOutlines = new Map();

    if (!isIncremental) {
        // Stage 1: Bounded 2-way parallel deep anatomy
        currentStep = 1;
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps}（并发 ${concurrency} 路）：深度解剖多章句法视角尺度 & 筛选多场景灵魂范例...`,
        });

        const trainTextCombined = [
            '【原著样本 A（开篇定调）】：\n' + samples.sampleA,
            samples.sampleC ? '【原著样本 C（中段过渡/对话）】：\n' + samples.sampleC : '',
            '【原著样本 B（夺舍节点）】：\n' + samples.sampleB,
        ].filter(Boolean).join('\n\n');

        const [anatomySyntaxRaw, anatomyDialogueRaw] = await runBoundedPool([
            () => callModel({
                stage: '1A_syntax_anatomy',
                systemPrompt: analystSystem,
                prompt: [
                    `以下是小说《${novelData.title}》的本地客观统计指纹与多章节原著样本。`,
                    '请做「法医级微观句法、视角与感官尺度深度解剖」（越具体、越细粒度越好，多引用原著里的真实短句作为依据，不要复述剧情）：',
                    '1. 叙事视角与心理距离：人称视角如何运作？是否有视角微滑？内心想法是直白写出来、用极短碎片词带过，还是全靠微动作折射？',
                    '2. 句法骨架与动词/修辞偏好：长短句交替规律、主语省略习惯、高频动作动词类型（急躁暴力 vs 缓慢粘稠？）、比喻习惯（通俗直给还是书面文艺？）。',
                    '3. 分场景描写策略：日常铺垫、人物对峙、高张力/亲密/感官桥段分别怎么运镜？内容尺度落在哪一档？',
                    '4. 初步发现的“原著绝不会使用的 AI 味/出版味表达”清单。',
                    '',
                    '【本地客观统计指纹】：',
                    fingerprintText,
                    '',
                    trainTextCombined,
                ].join('\n'),
            }),
            () => callModel({
                stage: '1B_dialogue_excerpts',
                systemPrompt: analystSystem,
                prompt: [
                    `以下是小说《${novelData.title}》的多章节原著样本。`,
                    '请完成两项任务，严格按 `<dialogue_pacing>` 和 `<excerpts>` 两个标签输出：',
                    '1. 在 `<dialogue_pacing>` 中深度解剖：',
                    '   - 台词节奏与口癖：台词长度、口语松散度、引号内外标点习惯（是否经常省略句末标点直接接动作？）、省略号/波浪号/感叹号/特殊符号的实际用法。',
                    '   - 角色声线反差：核心登场角色说话风格、情绪温度和反应方式有什么鲜明反差？',
                    '   - 场景推进与转场：一节之内如何切镜、如何制造压迫感或悬念？',
                    '2. 在 `<excerpts>` 中，从下方样本里**一字不改原样摘录 3~4 段**不同场景（例如：日常氛围、对话交锋、微观感官/张力描写）最具作者灵魂辨识度的原文片段（每段 200~300 字，标注代表什么笔法特征），供后续 Few-Shot 语感锚定。',
                    '',
                    trainTextCombined,
                ].join('\n'),
            }),
        ], concurrency);

        const syntaxNotes = stripNonStoryBlocks(anatomySyntaxRaw);
        const dialogueNotes = extractTaggedSection(anatomyDialogueRaw, 'dialogue_pacing');
        goldenExcerpts = extractTaggedSection(anatomyDialogueRaw, 'excerpts');

        // Stage 2: Bounded 2-way parallel (Merge Deep Draft Style Bible || Strip Holdout #1 dry outline)
        currentStep = 2;
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps}（并发 ${concurrency} 路）：合成初版深度文风圣经 & 剥离第 1 轮盲测事件大纲...`,
        });

        const [draftCardRaw, dryOutline1Raw] = await runBoundedPool([
            () => callModel({
                stage: '2A_merge_draft',
                systemPrompt: analystSystem,
                prompt: [
                    `请将以下关于《${novelData.title}》的本地统计指纹与两份深度文风剖析，去噪融合成一份详尽、可落地执行的【初版原著文风 DNA 圣经】（目标 **1,600 ~ 2,400 字**，宁要细致实操规则与原著短句示例，不要空泛浓缩！）。`,
                    '必须分模块写清：',
                    '一、叙事视角与心理表达铁律（含正反例句）',
                    '二、句式、段长、排版与标点口癖（含具体数值锚点与标点示例）',
                    '三、对话结构与核心人物声线反差',
                    '四、分场景节奏推进与内容尺度定位',
                    '五、原作者招牌动词/感官描写抓手（附原著实句拆解）',
                    '六、初步反 AI 味禁忌清单',
                    '请用 `<style_dna>...</style_dna>` 包裹输出。',
                    '',
                    '【本地客观统计指纹】：',
                    fingerprintText,
                    '',
                    '【微观句法与尺度剖析】：',
                    syntaxNotes,
                    '',
                    '【对话与角色声线剖析】：',
                    dialogueNotes,
                ].join('\n'),
            }),
            () => callModel({
                stage: '2B_extract_dry_outline_1',
                systemPrompt: outlineSystem,
                prompt: [
                    '请将下面这段小说原文压缩成 3~5 句极度干瘪客观的事件大纲（只写时间地点、人物、动作顺序与客观结果，严禁照抄原句修辞与台词）：',
                    '',
                    samples.holdouts[0].text,
                ].join('\n'),
            }),
        ], concurrency);

        currentStyleCard = extractTaggedSection(draftCardRaw, 'style_dna');
        preStrippedOutlines.set(0, stripNonStoryBlocks(dryOutline1Raw));
    }

    // Iterative Adversarial Blind-Test & Forensic Calibration Loop
    const startRoundIdx = isIncremental ? roundHistory.length : 0;
    const loopCount = isIncremental ? 1 : targetRounds;

    for (let offset = 0; offset < loopCount; offset += 1) {
        const roundNum = startRoundIdx + offset + 1;
        const holdoutIdx = (startRoundIdx + offset) % samples.holdouts.length;
        const holdout = samples.holdouts[holdoutIdx];

        let dryOutline = preStrippedOutlines.get(holdoutIdx);
        if (!dryOutline) {
            const rawOutline = await callModel({
                stage: `outline_round_${roundNum}`,
                systemPrompt: outlineSystem,
                prompt: [
                    '请将下面这段小说原文压缩成 3~5 句极度干瘪客观的事件大纲（只写时间地点、人物、动作顺序与客观结果，严禁照抄原句修辞与台词）：',
                    '',
                    holdout.text,
                ].join('\n'),
            });
            dryOutline = stripNonStoryBlocks(rawOutline);
            preStrippedOutlines.set(holdoutIdx, dryOutline);
        }

        // Step A of Round: Blind Rewrite (optionally prefetch next round's dry outline in parallel, concurrency <= 2!)
        currentStep += 1;
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps}（第 ${roundNum} 轮盲测考试）：不看「${holdout.label}」原文，仅凭当前文风圣经蒙眼仿写...`,
        });

        const nextHoldoutIdx = (startRoundIdx + offset + 1) % samples.holdouts.length;
        const shouldPrefetchNextOutline = (offset + 1 < loopCount) && !preStrippedOutlines.has(nextHoldoutIdx);

        const roundTasks = [
            () => callModel({
                stage: `3_round${roundNum}_blind_rewrite`,
                systemPrompt: ghostwriterSystem,
                prompt: [
                    `【目标作品】：《${novelData.title}》`,
                    '【本地硬指标】：',
                    fingerprintText,
                    '',
                    '【当前版原著文风 DNA 圣经】：',
                    currentStyleCard,
                    '',
                    '【原著灵魂原文范例】：',
                    goldenExcerpts,
                    '',
                    '【本次盲测事件大纲（请严格按上述文风圣经扩写成 800~1000 字连续正文）】：',
                    dryOutline,
                ].join('\n'),
            }),
        ];

        if (shouldPrefetchNextOutline) {
            const nextHoldout = samples.holdouts[nextHoldoutIdx];
            roundTasks.push(() => callModel({
                stage: `outline_round_${roundNum + 1}`,
                systemPrompt: outlineSystem,
                prompt: [
                    '请将下面这段小说原文压缩成 3~5 句极度干瘪客观的事件大纲（只写时间地点、人物、动作顺序与客观结果，严禁照抄原句修辞与台词）：',
                    '',
                    nextHoldout.text,
                ].join('\n'),
            }));
        }

        const [blindRewriteRaw, prefetchedOutlineRaw] = await runBoundedPool(roundTasks, concurrency);
        const blindRewrite = stripNonStoryBlocks(blindRewriteRaw);
        if (shouldPrefetchNextOutline && prefetchedOutlineRaw) {
            preStrippedOutlines.set(nextHoldoutIdx, stripNonStoryBlocks(prefetchedOutlineRaw));
        }

        // Step B of Round: Forensic Diff, Fidelity Scoring (0~100), & Style Bible Patching
        currentStep += 1;
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps}（第 ${roundNum} 轮真迹对比评分）：左右对照原著真迹与盲测仿写，打分并迭代强化文风圣经...`,
        });

        const prevScoresText = roundHistory.length > 0
            ? `此前轮次得分记录：${roundHistory.map(r => `第${r.round}轮 ${r.score ?? '?'}分`).join(' → ')}`
            : '这是第 1 轮对抗盲测。';

        const calibrationRaw = await callModel({
            stage: `4_round${roundNum}_forensic_diff`,
            systemPrompt: analystSystem,
            prompt: [
                `现在进行第 ${roundNum} 轮「原著真迹 vs AI 盲测仿写」法医级盲评对比与文风圣经迭代升级——目标作品：《${novelData.title}》。`,
                prevScoresText,
                '请把下面两段写同一件事的文本逐句对比，客观评估 AI 仿写与原作者真迹的文风相似度（0~100分，严格打分，有明显 AI 味不得超过 75 分，极度逼近真迹才给 90+ 分），揪出所有残留破绽，并升级【原著文风 DNA 圣经】！',
                '',
                '严格按以下三个标签输出：',
                '<score>',
                '（仅输出 0~100 的整数总分，例如：86）',
                '</score>',
                '<diff_notes>',
                '（先给出一行分项评分：句式节奏 X/20 | 视角心理 X/20 | 对话口癖 X/20 | 尺度氛围 X/20 | 去AI味纯度 X/20；再用 3~5 条具体要点列出本轮揪出的残留破绽及原著真迹对比）',
                '</diff_notes>',
                '<style_dna>',
                '（升级后的深度版《原著文风 DNA 圣经》，**必须保持 1,800 ~ 2,800 字的详尽实操体量**，严禁把之前已经验证有效的铁律删减或浓缩成空话！必须保留并持续扩充：',
                '  一、叙事视角与心理表达铁律（附实句示例）',
                '  二、句式、段长、排版与对话标点口癖（附实句示例）',
                '  三、核心人物声线反差与互动动力学',
                '  四、分场景推进节奏与内容尺度边界',
                '  五、原作者招牌动词、感官抓手与高频语感库',
                '  六、【经多轮盲测累积的反 AI 味纠偏黑名单】（每条采用“❌ AI常见错误写法 → ✅ 原著真实写法”的实句对照））',
                '</style_dna>',
                '',
                '【当前版文风圣经（请在此基础上吸收新发现并强化，不要丢失旧铁律）】：',
                currentStyleCard,
                '',
                `【原作者真实原文（${holdout.label}）】：`,
                holdout.text,
                '',
                '【AI 本轮盲测仿写稿】：',
                blindRewrite,
            ].join('\n'),
        });

        const roundScore = extractFidelityScore(calibrationRaw);
        const roundDiffNotes = extractTaggedSection(calibrationRaw, 'diff_notes');
        const nextStyleCard = extractTaggedSection(calibrationRaw, 'style_dna');
        if (nextStyleCard && nextStyleCard.length >= 200) {
            currentStyleCard = nextStyleCard;
        }

        roundHistory.push({
            round: roundNum,
            holdoutLabel: holdout.label,
            score: roundScore,
            diffNotes: roundDiffNotes,
        });

        // Early convergence if >= 2 rounds completed and score already reached 92+
        if (!isIncremental && roundNum >= 2 && roundScore !== null && roundScore >= 92) {
            break;
        }
    }

    const latestScore = roundHistory.length > 0 ? roundHistory[roundHistory.length - 1].score : null;
    const summaryDiffFindings = roundHistory
        .map(r => `【第 ${r.round} 轮盲测 · ${r.holdoutLabel} · 相似度：${r.score !== null ? `${r.score}/100` : '已评估'}】\n${r.diffNotes}`)
        .join('\n\n');

    return {
        version: 2,
        title: novelData.title,
        cutoffChapterIndex: cutoff,
        distilledAt: Date.now(),
        roundsCompleted: roundHistory.length,
        latestScore,
        roundHistory,
        fingerprint,
        fingerprintText,
        styleCard: currentStyleCard,
        goldenExcerpts,
        diffFindings: summaryDiffFindings,
    };
}
