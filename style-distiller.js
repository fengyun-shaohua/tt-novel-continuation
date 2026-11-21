/**
 * Bounded-Concurrency (max <= 2) Multi-Stage Adversarial Style Distillation Pipeline
 * for the Novel Continuation extension.
 *
 * Stages:
 *   Stage 0 (Local, 0 API): Objective statistical fingerprint + non-overlapping train/holdout split
 *   Stage 1 (2-way parallel): 1A Micro-syntax/POV/sensory anatomy || 1B Dialogue/pacing/golden excerpts
 *   Stage 2 (2-way parallel): 2A Merge draft Style DNA card       || 2B Strip holdout truth into dry plot outline
 *   Stage 3 (Serial, 1 call): Blind rewrite of the dry outline using ONLY the draft Style DNA card
 *   Stage 4 (Serial, 1 call): Forensic diff (Original Holdout Truth vs Blind Rewrite) -> Final Anti-AI-Slop Style DNA Card
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

    // Count first-person vs third-person pronouns outside dialogue quotes for POV hint
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
 * Splits chapters `1 .. cutoffChapterIndex` into non-overlapping training samples (A & B)
 * and a holdout ground-truth excerpt for blind adversarial rewrite testing.
 *
 * @param {Array<{ index: number, title: string, content: string }>} chapters
 * @param {number} cutoffChapterIndex
 */
export function selectDistillationSamples(chapters, cutoffChapterIndex) {
    const allowed = (chapters || [])
        .filter(c => c && c.index >= 1 && (!cutoffChapterIndex || c.index <= cutoffChapterIndex))
        .sort((a, b) => a.index - b.index);

    if (allowed.length === 0) {
        return { sampleA: '', sampleB: '', holdoutTruth: '', holdoutLabel: '' };
    }

    const cleanBody = (ch) => String(ch.content || '')
        .replace(/^-{4,}[\s\S]{0,220}?-{4,}\s*/m, '')
        .trim();

    if (allowed.length === 1) {
        const text = cleanBody(allowed[0]);
        const len = text.length;
        const cut1 = Math.floor(len * 0.4);
        const cut2 = Math.floor(len * 0.65);
        return {
            sampleA: `【${allowed[0].title}·前段】\n${text.slice(0, Math.min(cut1, 2200))}`,
            sampleB: `【${allowed[0].title}·后段】\n${text.slice(cut2, Math.min(len, cut2 + 2200))}`,
            holdoutTruth: text.slice(cut1, Math.min(cut2, cut1 + 1000)).trim() || text.slice(0, 800),
            holdoutLabel: `${allowed[0].title}·中段真迹`,
        };
    }

    if (allowed.length === 2) {
        const c0 = cleanBody(allowed[0]);
        const c1 = cleanBody(allowed[1]);
        const midStart = Math.floor(c0.length * 0.55);
        return {
            sampleA: `【${allowed[0].title}·前段】\n${c0.slice(0, Math.min(midStart, 2400))}`,
            sampleB: `【${allowed[1].title}】\n${c1.slice(-2600)}`,
            holdoutTruth: c0.slice(midStart, Math.min(c0.length, midStart + 1000)).trim() || c1.slice(0, 900),
            holdoutLabel: `${allowed[0].title}·后段真迹`,
        };
    }

    // 3+ chapters: sampleA from early chapter, holdoutTruth from middle chapter, sampleB from cutoff chapter (+ neighbor)
    const earlyCh = allowed[0];
    const midIdx = Math.floor(allowed.length / 2);
    const holdoutCh = allowed[midIdx === allowed.length - 1 ? allowed.length - 2 : midIdx];
    const latestCh = allowed[allowed.length - 1];

    const earlyText = cleanBody(earlyCh);
    const holdoutFull = cleanBody(holdoutCh);
    const latestText = cleanBody(latestCh);

    // Pick a rich middle slice of holdoutCh (avoiding chapter intro boilerplate)
    const hStart = holdoutFull.length > 1400 ? Math.floor(holdoutFull.length * 0.25) : 0;
    const holdoutSlice = holdoutFull.slice(hStart, hStart + 1050).trim();

    const sampleAParts = [`【${earlyCh.title}】\n${earlyText.slice(0, 2500)}`];
    if (allowed.length >= 5) {
        const secondEarly = allowed[1];
        sampleAParts.push(`【${secondEarly.title}·节选】\n${cleanBody(secondEarly).slice(0, 1200)}`);
    }

    const sampleBParts = [];
    if (allowed.length >= 4) {
        const prevLatest = allowed[allowed.length - 2];
        if (prevLatest.index !== holdoutCh.index) {
            sampleBParts.push(`【${prevLatest.title}·节选】\n${cleanBody(prevLatest).slice(-1200)}`);
        }
    }
    sampleBParts.push(`【${latestCh.title}（夺舍节点）】\n${latestText.slice(-2600)}`);

    return {
        sampleA: sampleAParts.join('\n\n'),
        sampleB: sampleBParts.join('\n\n'),
        holdoutTruth: holdoutSlice,
        holdoutLabel: `${holdoutCh.title}·真迹片段`,
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
 * Executes the 4-stage bounded-concurrency (<= 2) adversarial style distillation pipeline.
 *
 * @param {{
 *   novelData: { title: string, cutoffChapterIndex: number, totalChapters: number, chapters: Array<{ index: number, title: string, content: string }> },
 *   callModel: (args: { prompt: string, systemPrompt: string, stage: string }) => Promise<string>,
 *   maxConcurrency?: number,
 *   onProgress?: (info: { step: number, totalSteps: number, label: string }) => void,
 * }} params
 */
export async function runStyleDistillationPipeline({
    novelData,
    callModel,
    maxConcurrency = 2,
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

    // Stage 0: Local objective fingerprint + train/holdout split (0 API calls)
    onProgress({ step: 0, totalSteps: 4, label: '正在计算本地客观文风指纹与切分盲测真迹样本...' });
    const fingerprint = computeLocalStyleFingerprint(novelData.chapters, cutoff);
    const fingerprintText = formatFingerprintText(fingerprint);
    const samples = selectDistillationSamples(novelData.chapters, cutoff);

    if (!samples.sampleA || !samples.holdoutTruth) {
        throw new Error('原著文本过短，无法切分训练样本与盲测样本');
    }

    const analystSystem = '你是一位顶尖文学编辑与法医级文风分析师。你严禁输出“文笔细腻、描写生动、节奏紧凑”这类空泛形容词，必须输出具体、可量化、可直接照抄执行的写作硬规则。';

    // Stage 1: Bounded 2-way parallel deep anatomy (1A Syntax/POV/Sensory || 1B Dialogue/Pacing/Excerpts)
    onProgress({
        step: 1,
        totalSteps: 4,
        label: `步骤 1/4（并发 ${concurrency} 路）：并行解剖句法视角尺度 & 对话节奏与灵魂范例...`,
    });

    const [anatomySyntaxRaw, anatomyDialogueRaw] = await runBoundedPool([
        () => callModel({
            stage: '1A_syntax_anatomy',
            systemPrompt: analystSystem,
            prompt: [
                `以下是小说《${novelData.title}》的本地客观统计指纹与两段不同进度的原著样本。`,
                '请做「法医级微观句法与感官尺度解剖」，严格围绕以下 4 点输出具体可执行的分析（不要复述剧情）：',
                '1. 叙事视角与心理距离：紧贴谁的感官？内心想法是直白写出（包括破折号/内心独白），还是全靠微动作折射？',
                '2. 句式骨架与修辞密度：长短句交替规律、动词/形容词使用习惯、比喻风格（直白通俗还是华丽书面？）。',
                '3. 感官描写与内容尺度：写高张力/亲密/冲突桥段时，笔触是直白直接还是含蓄隐晦？用词尺度落在哪一档？',
                '4. 初步发现的“原著绝不会用的 AI 味表达”清单。',
                '',
                '【本地客观统计指纹】：',
                fingerprintText,
                '',
                '【原著样本 A】：',
                samples.sampleA,
                '',
                '【原著样本 B】：',
                samples.sampleB,
            ].join('\n'),
        }),
        () => callModel({
            stage: '1B_dialogue_excerpts',
            systemPrompt: analystSystem,
            prompt: [
                `以下是小说《${novelData.title}》的两段原著样本。`,
                '请完成两项任务，严格按 `<dialogue_pacing>` 和 `<excerpts>` 两个标签输出：',
                '1. 在 `<dialogue_pacing>` 中解剖：',
                '   - 对话风格：台词长度、口语化程度、断句停顿与标点习惯（省略号、波浪号、感叹号、特殊语气词）。',
                '   - 动作夹杂方式：台词前后怎么配动作神态？',
                '   - 场景推进节奏：铺垫长度、转场速度、情绪爆发频率。',
                '2. 在 `<excerpts>` 中，从下方样本里**一字不改原样摘录** 2 段最具作者灵魂辨识度的原文片段（每段 150~240 字，标注代表什么风格特征），供后续 Few-Shot 语感锚定。',
                '',
                '【原著样本 A】：',
                samples.sampleA,
                '',
                '【原著样本 B】：',
                samples.sampleB,
            ].join('\n'),
        }),
    ], concurrency);

    const syntaxNotes = stripNonStoryBlocks(anatomySyntaxRaw);
    const dialogueNotes = extractTaggedSection(anatomyDialogueRaw, 'dialogue_pacing');
    const goldenExcerpts = extractTaggedSection(anatomyDialogueRaw, 'excerpts');

    // Stage 2: Bounded 2-way parallel (2A Merge Draft Style DNA || 2B Strip Holdout Truth into dry event outline)
    onProgress({
        step: 2,
        totalSteps: 4,
        label: `步骤 2/4（并发 ${concurrency} 路）：融合初版文风 DNA 卡 & 剥离盲测事件大纲...`,
    });

    const [draftCardRaw, dryOutlineRaw] = await runBoundedPool([
        () => callModel({
            stage: '2A_merge_draft',
            systemPrompt: analystSystem,
            prompt: [
                `请将以下关于《${novelData.title}》的本地统计指纹与两份微观文风剖析，去噪融合成一份精炼、可直接下发给续写 AI 执行的【初版原著文风 DNA 执行卡】（严格控制在 500~750 字内）。`,
                '要求：剔除只属于单个情节的细节，只保留跨章稳定的作者笔法、节奏、对话习惯、尺度要求与初步禁忌。',
                '请用 `<style_dna>...</style_dna>` 包裹输出。',
                '',
                '【本地客观统计指纹】：',
                fingerprintText,
                '',
                '【微观句法与尺度剖析】：',
                syntaxNotes,
                '',
                '【对话与节奏剖析】：',
                dialogueNotes,
            ].join('\n'),
        }),
        () => callModel({
            stage: '2B_extract_dry_outline',
            systemPrompt: '你是剧情梗概提炼员。你的任务是把一段小说原文剥光一切文风、修辞、心理修饰和原句措辞，只还原成 3~4 句极度干瘪、客观、白开水般的“事件清单”，用于后续盲测仿写。',
            prompt: [
                '请将下面这段小说原文压缩成 3~4 句干瘪客观的事件大纲（说明时间地点、出场人物、依次发生的具体动作/结果，严禁照抄原句修辞与台词）：',
                '',
                samples.holdoutTruth,
            ].join('\n'),
        }),
    ], concurrency);

    const draftStyleCard = extractTaggedSection(draftCardRaw, 'style_dna');
    const dryOutline = stripNonStoryBlocks(dryOutlineRaw);

    // Stage 3: Serial Blind Rewrite Test (1 API call)
    onProgress({
        step: 3,
        totalSteps: 4,
        label: '步骤 3/4（盲测考试）：不看原著真迹，仅凭初版文风卡蒙眼仿写测试段...',
    });

    const blindRewriteRaw = await callModel({
        stage: '3_blind_rewrite',
        systemPrompt: '你是一位小说代笔作者。请严格遵照给定的《原著文风 DNA 执行卡》和《灵魂原文范例》的笔触、节奏、标点和尺度，将给定的干瘪事件大纲扩写成一段 700~900 字的小说正文。直接输出正文，切勿解释。',
        prompt: [
            `【目标作品】：《${novelData.title}》`,
            '【本地硬指标】：',
            fingerprintText,
            '',
            '【初版原著文风 DNA 执行卡】：',
            draftStyleCard,
            '',
            '【原著灵魂原文范例】：',
            goldenExcerpts,
            '',
            '【本次盲测事件大纲（请按上述文风扩写成 700~900 字连续正文）】：',
            dryOutline,
        ].join('\n'),
    });
    const blindRewrite = stripNonStoryBlocks(blindRewriteRaw);

    // Stage 4: Serial Forensic Diff & Final Calibration (1 API call)
    onProgress({
        step: 4,
        totalSteps: 4,
        label: '步骤 4/4（真迹找茬纠偏）：左右对比原著真迹 vs 盲测仿写，锻造终版文风 DNA 卡...',
    });

    const finalCalibrationRaw = await callModel({
        stage: '4_forensic_diff',
        systemPrompt: analystSystem,
        prompt: [
            `现在进行最关键的「对抗找茬与终版文风校准」——目标作品：《${novelData.title}》。`,
            '下面左边（真迹）是原作者真实写的原文，右边（盲测稿）是 AI 仅凭【初版文风卡】写出来的仿写稿。',
            '请你做残酷、逐句的法医级盲评对比，找出所有暴露“AI 味”或偏离原作者味道的破绽（例如：是不是比喻太文艺/太书面？是不是多写了多余心理剖析或说教？是不是节奏拖慢了、对话太端着、情绪温度不对、或者内容尺度缩水/变形？），并据此修正【初版文风卡】！',
            '',
            '严格按以下两个标签输出：',
            '<diff_notes>',
            '（用 3~5 条精简要点列出本次盲测揪出的最大 AI 味破绽与修正方向，供作者审阅）',
            '</diff_notes>',
            '<style_dna>',
            '（最终定稿版《原著文风 DNA 执行卡》，650~900 字，必须包含：',
            '  1. 叙事视角与心理表达铁律',
            '  2. 句式、段长与对话标点口癖',
            '  3. 剧情推进节奏与内容尺度定位（明确贴合原著尺度）',
            '  4. 招牌描写抓手与高频语感',
            '  5. 【经盲测揪出的反 AI 味纠偏黑名单】（用“❌ 禁止…… → ✅ 改为……”的实操写法））',
            '</style_dna>',
            '',
            '【初版文风卡】：',
            draftStyleCard,
            '',
            `【原作者真实原文（${samples.holdoutLabel}）】：`,
            samples.holdoutTruth,
            '',
            '【AI 盲测仿写稿】：',
            blindRewrite,
        ].join('\n'),
    });

    const diffFindings = extractTaggedSection(finalCalibrationRaw, 'diff_notes');
    const finalStyleCard = extractTaggedSection(finalCalibrationRaw, 'style_dna');

    return {
        version: 1,
        title: novelData.title,
        cutoffChapterIndex: cutoff,
        distilledAt: Date.now(),
        fingerprint,
        fingerprintText,
        styleCard: finalStyleCard || draftStyleCard,
        goldenExcerpts,
        diffFindings,
    };
}
