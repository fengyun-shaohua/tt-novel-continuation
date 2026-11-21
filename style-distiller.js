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
    const paraLengths = paragraphs.map(p => p.replace(/\s+/g, '').length).sort((a, b) => a - b);
    const avgParagraphChars = Math.round(totalChars / Math.max(1, paragraphs.length));
    const p90ParagraphChars = paraLengths.length > 0
        ? paraLengths[Math.min(paraLengths.length - 1, Math.floor(paraLengths.length * 0.9))]
        : 0;
    const shortParagraphRatio = paraLengths.length > 0
        ? Math.round((paraLengths.filter(len => len <= 60).length / paraLengths.length) * 100)
        : 0;

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
        p90ParagraphChars,
        shortParagraphRatio,
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
    const paraTail = fp.p90ParagraphChars
        ? `（≤60字短段占 ${fp.shortParagraphRatio ?? 0}%，90%段落不超过 ${fp.p90ParagraphChars} 字）`
        : '';
    return [
        `- 叙事人称倾向：${fp.povHint}`,
        `- 段落骨相：平均每段 ${fp.avgParagraphChars} 字${paraTail}`,
        `- 句长节奏：平均每句 ${fp.avgSentenceChars} 字（≤15字短句占比 ${fp.shortSentenceRatio}%）`,
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
 * Strips thinking/CoT blocks, markdown code fences, and preset shell tags
 * (`<soliumbra_reply>`, `<game>`, `<reply>`) so blind rewrites and extracted sections stay pure prose.
 *
 * @param {string} rawText
 * @returns {string}
 */
export function cleanDistillProse(rawText) {
    return stripNonStoryBlocks(rawText)
        .replace(/^```(?:xml|html|markdown|md|txt)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .replace(/<\/?(?:soliumbra_reply|game|reply|output)\b[^>]*>/gi, '')
        .trim();
}

/**
 * Extracts text inside `<tag>...</tag>` after stripping thinking/CoT blocks and preset shells.
 * Falls back to the full cleaned text when tags are absent.
 *
 * @param {string} rawText
 * @param {string} tagName
 * @returns {string}
 */
export function extractTaggedSection(rawText, tagName) {
    const cleaned = cleanDistillProse(rawText);
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = cleaned.match(regex);
    if (match && match[1].trim()) {
        return match[1].trim();
    }
    return cleaned.trim();
}

/**
 * Computes an objective 0-API statistical drift comparison between Ground-Truth Holdout prose
 * and AI Blind Rewrite prose so both Judge and next-round Ghostwriter receive exact physical targets.
 *
 * @param {string} truthText
 * @param {string} rewriteText
 */
export function computeStyleDriftReport(truthText, rewriteText) {
    const truthFp = computeLocalStyleFingerprint([{ index: 1, title: '', content: String(truthText || '') }], 1);
    const rewriteFp = computeLocalStyleFingerprint([{ index: 1, title: '', content: String(rewriteText || '') }], 1);

    const warnings = [];
    if (truthFp.avgParagraphChars > 0) {
        const ratio = (rewriteFp.avgParagraphChars - truthFp.avgParagraphChars) / truthFp.avgParagraphChars;
        if (ratio >= 0.35) {
            warnings.push(`仿写平均段长偏长（${rewriteFp.avgParagraphChars}字 vs 真迹${truthFp.avgParagraphChars}字），下一轮必须切短自然段！`);
        } else if (ratio <= -0.35) {
            warnings.push(`仿写平均段长过碎（${rewriteFp.avgParagraphChars}字 vs 真迹${truthFp.avgParagraphChars}字），适当合并连贯动作。`);
        }
    }
    const shortParaDiff = (rewriteFp.shortParagraphRatio ?? 0) - (truthFp.shortParagraphRatio ?? 0);
    if (shortParaDiff <= -18) {
        warnings.push(`≤60字短段占比偏低（${rewriteFp.shortParagraphRatio}% vs 真迹${truthFp.shortParagraphRatio}%），严禁写冗长段落。`);
    }
    const dialDiff = rewriteFp.dialogueRatio - truthFp.dialogueRatio;
    if (Math.abs(dialDiff) >= 15) {
        warnings.push(`对话占比偏离真迹（${rewriteFp.dialogueRatio}% vs 真迹${truthFp.dialogueRatio}%）。`);
    }
    const tEllipsis = truthFp.punctuationPer1k?.ellipsis ?? 0;
    const rEllipsis = rewriteFp.punctuationPer1k?.ellipsis ?? 0;
    if (tEllipsis >= 8 && Math.abs(rEllipsis - tEllipsis) / tEllipsis >= 0.5) {
        warnings.push(`省略号频次偏离（${rEllipsis}/千字 vs 真迹${tEllipsis}/千字）。`);
    }

    const lines = [
        `• 平均段长：真迹 ${truthFp.avgParagraphChars} 字（≤60字短段 ${truthFp.shortParagraphRatio}%） vs 仿写 ${rewriteFp.avgParagraphChars} 字（≤60字短段 ${rewriteFp.shortParagraphRatio}%）`,
        `• 句长节奏：真迹均句 ${truthFp.avgSentenceChars} 字（短句 ${truthFp.shortSentenceRatio}%） vs 仿写均句 ${rewriteFp.avgSentenceChars} 字（短句 ${rewriteFp.shortSentenceRatio}%）`,
        `• 对话密度：真迹 ${truthFp.dialogueRatio}%（均长 ${truthFp.avgDialogueChars} 字） vs 仿写 ${rewriteFp.dialogueRatio}%（均长 ${rewriteFp.avgDialogueChars} 字）`,
        `• 标点频次：省略号 ${tEllipsis} vs ${rEllipsis}/千字 | 感叹号 ${truthFp.punctuationPer1k?.exclamation ?? 0} vs ${rewriteFp.punctuationPer1k?.exclamation ?? 0}/千字`,
    ];
    if (warnings.length > 0) {
        lines.push(`• 🎯 客观硬偏差提醒：${warnings.join('；')}`);
    } else {
        lines.push('• ✅ 各项本地物理统计指标已高度贴合原著真迹！');
    }

    return {
        truthFp,
        rewriteFp,
        warnings,
        summary: lines.join('\n'),
    };
}

const PRESET_SKIP_IDENTIFIERS = new Set([
    'chatHistory',
    'worldInfoBefore',
    'worldInfoAfter',
    'personaDescription',
    'charDescription',
    'charPersonality',
    'scenario',
    'dialogueExamples',
    'SPresetSettings',
    'agentSystemPrompt',
    'agentTask',
    'agentResults',
]);

/**
 * Compiles a user-selected TauriTavern OpenAI/Chat Completion preset object (`prompts` + `prompt_order`)
 * into a `[{ role, content }, ...]` message array that faithfully mirrors TauriTavern's `PromptManager`
 * ordering:
 * - `injection_position = 0` (`RELATIVE`): placed before or after `chatHistory` in exact `prompt_order`.
 * - `injection_position = 1` (`ABSOLUTE`): injected in-chat at `injection_depth` (e.g. Depth 0 right after
 *   the user task message) ordered by `injection_order` and role, matching `src/scripts/openai.js`.
 * - `injection_position = 2` (`ATTACH_EXISTING`): attached to the start/end of the target role message.
 * - Optional `substitute` callback expands Tavern `{{...}}` macros on preset entries for both Tavern and Custom APIs.
 *
 * @param {any} presetObj
 * @param {{
 *   systemPrompt: string,
 *   userPrompt: string,
 *   customPrefix?: string,
 *   substitute?: ((text: string) => string) | null,
 * }} task
 * @returns {Array<{ role: string, content: string }>}
 */
export function buildDistillationPresetMessages(presetObj, { systemPrompt, userPrompt, customPrefix = '', substitute = null }) {
    const parseOptInt = (val, fallback) => {
        if (val === undefined || val === null || val === '') return fallback;
        const n = Number(val);
        return Number.isFinite(n) ? Math.floor(n) : fallback;
    };

    const preparePresetContent = (raw) => {
        let cleaned = String(raw ?? '')
            .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
            .replace(/<<<\|catgodml\|[\s\S]*?>>>/gi, '')
            .replace(/<run_tool_replacement>/gi, '')
            .replace(/<\|(?:sep|merge)\|>/gi, '');
        if (typeof substitute === 'function') {
            try {
                cleaned = String(substitute(cleaned) ?? '');
            } catch {
                // Keep raw cleaned text if host macro substitution throws
            }
        }
        return cleaned.trim();
    };

    const taskMessages = [];
    if (customPrefix && customPrefix.trim()) {
        taskMessages.push({ role: 'system', content: customPrefix.trim() });
    }
    if (systemPrompt && systemPrompt.trim()) {
        taskMessages.push({ role: 'system', content: systemPrompt.trim() });
    }
    taskMessages.push({ role: 'user', content: String(userPrompt || '').trim() });

    if (!presetObj || !Array.isArray(presetObj.prompts)) {
        return taskMessages;
    }

    const promptMap = new Map(presetObj.prompts.map(p => [p?.identifier, p]));
    const orderBucket = Array.isArray(presetObj.prompt_order)
        ? (presetObj.prompt_order.find(o => o?.character_id === 100001)
            || presetObj.prompt_order.find(o => o?.character_id === 100000)
            || presetObj.prompt_order[0])
        : null;

    const orderList = Array.isArray(orderBucket?.order)
        ? orderBucket.order
        : presetObj.prompts.map(p => ({ identifier: p?.identifier, enabled: p?.enabled !== false }));

    const beforeHistory = [];
    const afterHistory = [];
    const absoluteEntries = [];
    const attachedEntries = [];
    let passedChatHistory = false;

    for (const item of orderList) {
        if (!item?.identifier) continue;
        if (item.identifier === 'chatHistory') {
            passedChatHistory = true;
            continue;
        }
        if (item.enabled === false || PRESET_SKIP_IDENTIFIERS.has(item.identifier)) {
            continue;
        }
        const entry = promptMap.get(item.identifier);
        if (!entry || entry.marker) continue;

        // Skip generation-type-specific prompts that explicitly exclude normal runs (e.g. continue/impersonate only)
        if (Array.isArray(entry.injection_trigger) && entry.injection_trigger.length > 0 && !entry.injection_trigger.includes('normal')) {
            continue;
        }

        const text = preparePresetContent(entry.content);
        if (!text) continue;
        const role = ['system', 'user', 'assistant'].includes(entry.role) ? entry.role : 'system';
        const pos = parseOptInt(entry.injection_position, 0);

        if (pos === 1) {
            absoluteEntries.push({
                role,
                content: text,
                injection_depth: Math.max(0, parseOptInt(entry.injection_depth, 4)),
                injection_order: parseOptInt(entry.injection_order, 100),
            });
        } else if (pos === 2) {
            attachedEntries.push({
                content: text,
                attach_role: ['system', 'user', 'assistant'].includes(entry.attach_role) ? entry.attach_role : 'user',
                attach_index: Math.max(1, parseOptInt(entry.attach_index, 1)),
                attach_side: entry.attach_side === 'start' ? 'start' : 'end',
            });
        } else if (passedChatHistory) {
            afterHistory.push({ role, content: text });
        } else {
            beforeHistory.push({ role, content: text });
        }
    }

    if (beforeHistory.length === 0 && afterHistory.length === 0 && absoluteEntries.length === 0 && attachedEntries.length === 0) {
        return taskMessages;
    }

    // Work in latest-first order to mirror TauriTavern's `applyAttachedPromptsToMessages` & `populationInjectionPrompts`
    const chatMessages = taskMessages.map(m => ({ ...m })).reverse();

    for (const att of attachedEntries) {
        let seen = 0;
        for (const msg of chatMessages) {
            if (msg.role !== att.attach_role) continue;
            seen += 1;
            if (seen === att.attach_index) {
                msg.content = att.attach_side === 'start'
                    ? `${att.content}\n\n${msg.content}`
                    : `${msg.content}\n\n${att.content}`;
                break;
            }
        }
    }

    if (absoluteEntries.length > 0) {
        const maxDepth = Math.max(...absoluteEntries.map(e => e.injection_depth));
        let totalInserted = 0;

        for (let depth = 0; depth <= maxDepth; depth += 1) {
            const depthPrompts = absoluteEntries.filter(p => p.injection_depth === depth);
            if (depthPrompts.length === 0) continue;

            const orderGroups = new Map();
            for (const prompt of depthPrompts) {
                const key = prompt.injection_order;
                if (!orderGroups.has(key)) orderGroups.set(key, []);
                orderGroups.get(key).push(prompt);
            }

            const sortedOrders = [...orderGroups.keys()].sort((a, b) => b - a);
            const roleMessages = [];
            for (const orderKey of sortedOrders) {
                const group = orderGroups.get(orderKey);
                for (const role of ['system', 'user', 'assistant']) {
                    const joined = group
                        .filter(p => p.role === role)
                        .map(p => p.content)
                        .join('\n')
                        .trim();
                    if (joined) {
                        roleMessages.push({ role, content: joined });
                    }
                }
            }

            if (roleMessages.length > 0) {
                const injectIdx = Math.min(chatMessages.length, depth + totalInserted);
                chatMessages.splice(injectIdx, 0, ...roleMessages);
                totalInserted += roleMessages.length;
            }
        }
    }

    chatMessages.reverse();
    return [...beforeHistory, ...chatMessages, ...afterHistory];
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
    evaluateOnly = false,
    onProgress = () => {},
}) {
    if (!novelData?.chapters?.length) {
        throw new Error('请先导入原著小说后再进行文风蒸馏');
    }
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }
    if (evaluateOnly && !existingProfile?.styleCard) {
        throw new Error('当前还没有已生成的文风圣经可供纯跑分验收');
    }

    const cutoff = Number(novelData.cutoffChapterIndex || novelData.totalChapters);
    const concurrency = Math.max(1, Math.min(2, Number(maxConcurrency) || 2));
    const targetRounds = Math.max(1, Math.min(3, Number(rounds) || 2));
    const isIncremental = Boolean(existingProfile?.styleCard) || evaluateOnly;

    const totalSteps = isIncremental ? 2 : (2 + targetRounds * 2);
    let currentStep = 0;

    const fingerprint = existingProfile?.fingerprint || computeLocalStyleFingerprint(novelData.chapters, cutoff);
    const fingerprintText = existingProfile?.fingerprintText || formatFingerprintText(fingerprint);
    const samples = selectDistillationSamples(novelData.chapters, cutoff);

    if (!samples.sampleA || samples.holdouts.length === 0) {
        throw new Error('原著文本过短，无法切分训练样本与盲测真迹样本');
    }

    const analystSystem = '你是一位顶尖文学编辑与法医级文风分析师。你严禁输出“文笔细腻、描写生动、节奏紧凑”这类空泛形容词，必须输出详尽、具体、可量化、附带原著实句对照的深度写作圣经，重点抓住原著的【段落骨相、零抒情克制感、视角呼吸与去网文八股替换动作】。';
    const outlineSystem = '你是剧情梗概提炼员。你的任务是把一段小说原文剥光一切文风、修辞、心理修饰和原句措辞，只还原成 4~6 句极度干瘪、客观、白开水般的“场景与节拍清单”，用于后续盲测仿写。';
    const ghostwriterSystem = '你是一位小说代笔作者。请严格遵照给定的《原著文风 DNA 圣经》和《原著灵魂活样本》的骨相、段长上限、节奏、标点和尺度，将干瘪事件大纲扩写成 750~950 字的小说正文。严禁原地水字数、严禁堆砌网文八股形容词。直接输出正文，切勿解释。';

    let currentStyleCard = existingProfile?.styleCard || '';
    let goldenExcerpts = existingProfile?.goldenExcerpts || '';
    const roundHistory = Array.isArray(existingProfile?.roundHistory) ? [...existingProfile.roundHistory] : [];
    const processLog = Array.isArray(existingProfile?.processLog) ? [...existingProfile.processLog] : [];
    const preStrippedOutlines = new Map();

    if (!isIncremental) {
        const stage0Entry = {
            id: 'stage0_fingerprint',
            type: 'stage',
            title: '阶段 0 · 本地统计指纹与无重叠样本切分（0 API）',
            summary: `统计 ${fingerprint.totalChars} 字（平均段长 ${fingerprint.avgParagraphChars} 字，≤60字短段占 ${fingerprint.shortParagraphRatio ?? 0}%，对话占比 ${fingerprint.dialogueRatio}%）；切分出 ${samples.holdouts.length} 组盲测真迹考题。`,
            detail: `${fingerprintText}\n\n盲测真迹考题池：\n${samples.holdouts.map((h, i) => `  ${i + 1}. ${h.label}（${h.text.length} 字）`).join('\n')}`,
        };
        processLog.push(stage0Entry);
        onProgress({
            step: 0,
            totalSteps,
            label: stage0Entry.summary,
            logEntry: stage0Entry,
        });

        // Stage 1: Bounded 2-way parallel deep anatomy
        currentStep = 1;
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps}（并发 ${concurrency} 路）：深度解剖多章骨相/句法/视角尺度 & 筛选多场景灵魂范例...`,
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
                    '请做「法医级骨相、句法、视角与感官尺度深度解剖」（越具体、越细粒度越好，多引用原著里的真实短句作为依据，不要复述剧情）：',
                    '1. 段落骨相与信息密度（决定神似而非形似）：原著单个自然段通常多长？是否极度惜墨、用短段快切推进？有没有超过 150 字的静态外貌/环境大段描写？氛围是靠抒情形容词渲染，还是靠冷冰冰的白描动作与留白？',
                    '2. 叙事视角与内心独白质感：人称视角如何运作？主角内心独白是直接穿插在段落里的口语碎碎念（无引号），还是克制隐藏？情绪温度偏松弛冷眼旁观还是浓烈煽情？',
                    '3. 句法骨架与动词/修辞偏好：长短句交替规律、主语省略习惯、高频动词质感、比喻密度（直白通俗还是书面文艺？）。',
                    '4. 分场景运镜与尺度边界：日常铺垫、人物对峙、高张力/亲密/感官桥段分别如何推进？',
                    '5. 初步发现的“原著绝不会使用的网文/AI八股”及对应的【原著真实替代写法】（用“想表达X时，原著直接写Y，而非套话Z”的格式）。',
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
                    '   - 角色声线反差：核心登场角色说话字数、寡言度、情绪温度和反抗/试探方式有什么鲜明反差？',
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

        const stage1aEntry = {
            id: 'stage1a_anatomy',
            type: 'stage',
            title: '阶段 1A · 骨相、段落节奏、视角与尺度深度解剖',
            summary: `产出 ${syntaxNotes.length} 字微观骨相剖析`,
            detail: syntaxNotes,
        };
        const stage1bEntry = {
            id: 'stage1b_dialogue',
            type: 'stage',
            title: '阶段 1B · 对话声线反差与原著灵魂范例摘录',
            summary: `产出 ${dialogueNotes.length} 字声线剖析 + ${goldenExcerpts.length} 字原著黄金范例`,
            detail: `【对话与声线剖析】\n${dialogueNotes}\n\n【原著灵魂原文范例】\n${goldenExcerpts}`,
        };
        processLog.push(stage1aEntry, stage1bEntry);
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps} 完成：已产出微观骨相剖析与灵魂范例摘录`,
            logEntry: stage1aEntry,
        });
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps} 完成：已收录黄金范例`,
            logEntry: stage1bEntry,
        });

        // Stage 2: Bounded 2-way parallel (Merge Deep Draft Style Bible || Strip Holdout #1 dry outline)
        currentStep = 2;
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps}（并发 ${concurrency} 路）：合成初版深度文风骨相圣经 & 剥离第 1 轮盲测节拍清单...`,
        });

        const [draftCardRaw, dryOutline1Raw] = await runBoundedPool([
            () => callModel({
                stage: '2A_merge_draft',
                systemPrompt: analystSystem,
                prompt: [
                    `请将以下关于《${novelData.title}》的本地统计指纹与两份深度文风剖析，去噪融合成一份详尽、可落地执行的【初版原著文风骨相 DNA 圣经】（目标 **1,800 ~ 2,600 字**，宁要细致实操规则与原著短句示例，不要空泛浓缩！）。`,
                    '必须分模块写清：',
                    '一、段落骨相与防注水硬红线（明确单段字数上限、短段快切比例、严禁大段静态氛围/外貌水字数）',
                    '二、叙事视角、内心独白口吻与零抒情克制度（含原著实句示例）',
                    '三、句式、排版与标点口癖（含具体数值锚点与标点示例）',
                    '四、对话结构与核心人物声线/寡言度反差',
                    '五、分场景推进节奏与内容尺度定位',
                    '六、原作者招牌动词/感官抓手与【反八股正向替换清单】（用“写某反应时 → 直接用原著某白描动作，绝不用套话”的实句对照）',
                    '请用 `<style_dna>...</style_dna>` 包裹输出。',
                    '',
                    '【本地客观统计指纹】：',
                    fingerprintText,
                    '',
                    '【微观骨相与尺度剖析】：',
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
                    '请将下面这段小说原文压缩成 4~6 句客观的“场景与节拍清单”（按顺序列出时间地点、出场人物、每个动作与情绪转折节拍、结果，严禁照抄原句修辞与原话）：',
                    '',
                    samples.holdouts[0].text,
                ].join('\n'),
            }),
        ], concurrency);

        currentStyleCard = extractTaggedSection(draftCardRaw, 'style_dna');
        preStrippedOutlines.set(0, stripNonStoryBlocks(dryOutline1Raw));

        const stage2Entry = {
            id: 'stage2a_draft',
            type: 'stage',
            title: '阶段 2 · 初版《原著文风骨相圣经》合稿',
            summary: `初版文风圣经共 ${currentStyleCard.length} 字，即将进入盲测对抗打分`,
            detail: currentStyleCard,
        };
        processLog.push(stage2Entry);
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps} 完成：初版圣经（${currentStyleCard.length} 字）就绪，准备盲测考试`,
            logEntry: stage2Entry,
        });
    }

    // Iterative Adversarial Blind-Test & Forensic Calibration Loop
    const startRoundIdx = isIncremental ? roundHistory.length : 0;
    const loopCount = isIncremental ? 1 : targetRounds;
    let activeHoldoutCursor = startRoundIdx % samples.holdouts.length;
    let retestedHoldoutIdx = -1;
    let prevDriftWarnings = [];
    let bestRecord = {
        score: roundHistory.reduce((mx, r) => (r.score !== null && r.score > mx ? r.score : mx), -1),
        styleCard: currentStyleCard,
    };

    for (let offset = 0; offset < loopCount; offset += 1) {
        const roundNum = startRoundIdx + offset + 1;
        const holdoutIdx = activeHoldoutCursor % samples.holdouts.length;
        const holdout = samples.holdouts[holdoutIdx];
        const isRetest = retestedHoldoutIdx === holdoutIdx && offset > 0;
        const cardUsedThisRound = currentStyleCard;

        let dryOutline = preStrippedOutlines.get(holdoutIdx);
        if (!dryOutline) {
            const rawOutline = await callModel({
                stage: `outline_round_${roundNum}`,
                systemPrompt: outlineSystem,
                prompt: [
                    '请将下面这段小说原文压缩成 4~6 句客观的“场景与节拍清单”（按顺序列出时间地点、出场人物、每个动作与情绪转折节拍、结果，严禁照抄原句修辞与原话）：',
                    '',
                    holdout.text,
                ].join('\n'),
            });
            dryOutline = cleanDistillProse(rawOutline);
            preStrippedOutlines.set(holdoutIdx, dryOutline);
        }

        // Step A of Round: Blind Rewrite (optionally prefetch next unseen holdout's dry outline in parallel, concurrency <= 2!)
        currentStep += 1;
        onProgress({
            step: currentStep,
            totalSteps,
            label: `步骤 ${currentStep}/${totalSteps}（第 ${roundNum} 轮${isRetest ? '错题重考' : '盲测考试'}）：不看「${holdout.label}」原文，仅凭当前文风圣经蒙眼仿写...`,
        });

        const nextHoldoutIdx = (holdoutIdx + 1) % samples.holdouts.length;
        const shouldPrefetchNextOutline = (offset + 1 < loopCount) && !preStrippedOutlines.has(nextHoldoutIdx);

        const driftHintBlock = prevDriftWarnings.length > 0
            ? `\n【上一轮物理硬指标纠偏重点（本轮必须修正）】：\n- ${prevDriftWarnings.join('\n- ')}\n`
            : '';

        const roundTasks = [
            () => callModel({
                stage: `3_round${roundNum}_blind_rewrite`,
                systemPrompt: ghostwriterSystem,
                prompt: [
                    `【目标作品】：《${novelData.title}》`,
                    '【本地硬指标】：',
                    fingerprintText,
                    driftHintBlock,
                    '【当前版原著文风 DNA 圣经（请逐条严格执行，严禁机械照搬前文剧情原句）】：',
                    cardUsedThisRound,
                    '',
                    '【原著灵魂原文范例】：',
                    goldenExcerpts,
                    '',
                    '【本次盲测事件节拍大纲（请严格按上述文风圣经扩写成 750~950 字连续正文，直接输出纯正文，不要加任何外层标签）】：',
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
                    '请将下面这段小说原文压缩成 4~6 句客观的“场景与节拍清单”（按顺序列出时间地点、出场人物、每个动作与情绪转折节拍、结果，严禁照抄原句修辞与原话）：',
                    '',
                    nextHoldout.text,
                ].join('\n'),
            }));
        }

        const [blindRewriteRaw, prefetchedOutlineRaw] = await runBoundedPool(roundTasks, concurrency);
        const blindRewrite = cleanDistillProse(blindRewriteRaw);
        if (shouldPrefetchNextOutline && prefetchedOutlineRaw) {
            preStrippedOutlines.set(nextHoldoutIdx, cleanDistillProse(prefetchedOutlineRaw));
        }

        // Compute objective 0-API statistical drift between Holdout Truth and Blind Rewrite
        const driftReport = computeStyleDriftReport(holdout.text, blindRewrite);
        prevDriftWarnings = driftReport.warnings;

        // Step B of Round: Forensic Diff, Pure-Style Fidelity Scoring (0~100), & Optional Style Bible Refinement
        currentStep += 1;
        onProgress({
            step: currentStep,
            totalSteps,
            label: evaluateOnly
                ? `步骤 ${currentStep}/${totalSteps}（纯跑分验收 · 不改圣经）：对照物理指标与真迹盲评打分...`
                : `步骤 ${currentStep}/${totalSteps}（第 ${roundNum} 轮客观+法医对比评分）：对照物理指标与真迹打分，提纯升级圣经...`,
        });

        const prevScoresText = roundHistory.length > 0
            ? `此前轮次得分记录：${roundHistory.map(r => `第${r.round}轮 ${r.score ?? '?'}分`).join(' → ')}`
            : '这是第 1 轮对抗盲测。';

        const judgePromptLines = [
            evaluateOnly
                ? `现在对《${novelData.title}》当前版文风圣经（${cardUsedThisRound.length} 字）执行「纯跑分盲测验收」（只对比打分与找茬，不改写圣经）。`
                : `现在进行第 ${roundNum} 轮「原著真迹 vs AI 盲测仿写」法医级盲评对比与文风圣经提纯升级——目标作品：《${novelData.title}》。`,
            prevScoresText,
            '',
            '【本地 0-API 客观物理指标比对（真迹 vs 本轮仿写）】：',
            driftReport.summary,
            '',
            '【重要评分纪律（严禁伪扣分）】：',
            '1. 因为 AI 盲写时只看过干瘪事件大纲、从未看过本段原文，**严禁因为 AI 没猜中原文里特有的道具细节、具体比喻意象（例如某种具体颜色烤漆/怀表比喻/特定台词字眼）而扣分！** 只要 AI 写出了同等级别、符合原作者思维方式的细节白描，该项即为高分。',
            '2. 请结合上方客观物理指标表，严格只针对 **5 个可泛化的纯文风维度** 客观打分（满分 100）：句式段长节奏(20) + 叙事视角与心理克制度(20) + 对话口癖与标点质感(20) + 氛围推进与原著尺度贴合度(20) + 反AI味纯度(20)。',
            '3. 若仿写不仅物理指标贴合、且抓住了原作者的神韵与去AI味纯度，应公正给出 90~96 分；若存在跨场景机械拼贴（Overfitting）、长段注水或 AI 八股则如实扣分。',
            '',
        ];

        if (evaluateOnly) {
            judgePromptLines.push(
                '严格按以下两个标签输出（无需输出 `<style_dna>`）：',
                '<score>',
                '（仅输出 0~100 的整数总分，例如：91）',
                '</score>',
                '<diff_notes>',
                '（先给出一行分项评分：句式节奏 X/20 | 视角心理 X/20 | 对话口癖 X/20 | 尺度氛围 X/20 | 去AI味纯度 X/20；再用 3~4 条具体要点评价当前精炼圣经的实战还原表现与是否消除过拟合复读）',
                '</diff_notes>',
            );
        } else {
            judgePromptLines.push(
                '【核心防过拟合纪律（极其重要！）】：',
                '- **严禁把本次盲测真迹（或任何单章）里的具体剧情原句、特定物品描写直接抄进 `<style_dna>` 圣经！**（否则下一轮会背答案或在新章节里复读原句！）',
                '- `<style_dna>` 必须执行**去重压缩与泛化提纯**，总字数**严格控制在 1,600 ~ 2,600 字以内（绝对不可超过 3,000 字！）**，绝不允许无限滚雪球膨胀！',
                '',
                '严格按以下三个标签输出：',
                '<score>',
                '（仅输出 0~100 的整数总分，例如：91）',
                '</score>',
                '<diff_notes>',
                '（先给出一行分项评分：句式节奏 X/20 | 视角心理 X/20 | 对话口癖 X/20 | 尺度氛围 X/20 | 去AI味纯度 X/20；再用 3~4 条具体要点列出本轮揪出的可泛化文风差距）',
                '</diff_notes>',
                '<style_dna>',
                '（精炼提纯版《原著文风骨相 DNA 圣经》，**总字数严格控制在 1,600 ~ 2,600 字**，必须分五大模块：',
                '  一、段落骨相、句长与标点硬指标（含本地统计数值上限）',
                '  二、叙事视角、心理限制与分场景内心独白语态（如何按场景切换克制/松弛/审视语态，严禁跨场景乱拼）',
                '  三、对话节奏、核心人物声线反差与克制微动作法则',
                '  四、感官/静物白描方法论与内容尺度边界（写抽象技法，严禁抄入单章具体道具或整段原句！）',
                '  五、【精炼反 AI 味纠偏短例库】（严格保留最具代表性的 **6~10 组** 去剧情化短句对照：“❌ AI常见通病 → ✅ 原著通用笔法”，去重合并、优胜劣汰，严禁无限累加！））',
                '</style_dna>',
                '',
                '【当前版文风圣经（请在此基础上做去重提纯与精准修补，删除冗余与单章过拟合原句）】：',
                cardUsedThisRound,
            );
        }

        judgePromptLines.push(
            '',
            `【原作者真实原文（${holdout.label}，仅供本轮对比评分，严禁抄录其中具体情节句！）】：`,
            holdout.text,
            '',
            '【AI 本轮盲测仿写稿】：',
            blindRewrite,
        );

        const calibrationRaw = await callModel({
            stage: evaluateOnly ? `4_eval${roundNum}_readonly_score` : `4_round${roundNum}_forensic_diff`,
            systemPrompt: analystSystem,
            prompt: judgePromptLines.join('\n'),
        });

        const roundScore = extractFidelityScore(calibrationRaw);
        const roundDiffNotes = extractTaggedSection(calibrationRaw, 'diff_notes');
        let regressedOnRetest = false;

        if (!evaluateOnly) {
            const nextStyleCard = extractTaggedSection(calibrationRaw, 'style_dna');
            if (roundScore !== null && roundScore >= bestRecord.score) {
                bestRecord = { score: roundScore, styleCard: cardUsedThisRound };
            }
            regressedOnRetest = isRetest && roundScore !== null && bestRecord.score >= 0 && roundScore <= bestRecord.score - 3;
            if (regressedOnRetest) {
                currentStyleCard = bestRecord.styleCard;
            } else if (nextStyleCard && nextStyleCard.length >= 200) {
                currentStyleCard = nextStyleCard;
            }
        }

        const holdoutLabelFull = evaluateOnly
            ? `${holdout.label} (纯跑分验收·未改圣经)`
            : `${holdout.label}${isRetest ? ' (错题重考)' : ''}`;
        roundHistory.push({
            round: roundNum,
            holdoutLabel: holdoutLabelFull,
            score: roundScore,
            diffNotes: roundDiffNotes,
            evaluateOnly,
        });

        const roundLogEntry = {
            id: `round_${roundNum}`,
            type: 'round',
            round: roundNum,
            evaluateOnly,
            title: evaluateOnly
                ? `🧪 纯跑分验收（未改圣经）· 第 ${roundNum} 次 · ${holdout.label}`
                : `第 ${roundNum} 轮盲测对抗 · ${holdoutLabelFull}`,
            holdoutLabel: holdoutLabelFull,
            isRetest,
            score: roundScore,
            driftReport: driftReport.summary,
            dryOutline,
            blindRewrite,
            holdoutTruth: holdout.text,
            diffNotes: `${roundDiffNotes}${regressedOnRetest ? '\n\n[择优保护] 本轮重考分数回落，已自动保留历史最高分版本圣经。' : ''}`,
            styleCardLength: currentStyleCard.length,
        };
        processLog.push(roundLogEntry);
        onProgress({
            step: currentStep,
            totalSteps,
            label: evaluateOnly
                ? `🧪 纯跑分验收完成：${roundScore !== null ? `${roundScore}/100 分` : '已评估'}（圣经保持 ${currentStyleCard.length} 字未改动）`
                : `第 ${roundNum} 轮盲测评分完成：${roundScore !== null ? `${roundScore}/100 分` : '已评估'}（圣经现 ${currentStyleCard.length} 字）`,
            logEntry: roundLogEntry,
        });

        // Early convergence if >= 2 rounds completed and score already reached 92+
        if (!isIncremental && roundNum >= 2 && roundScore !== null && roundScore >= 92) {
            break;
        }

        // Same-holdout re-test if score < 90 and this holdout hasn't been re-tested yet; otherwise advance to next unseen holdout
        if (!isIncremental && roundScore !== null && roundScore < 90 && retestedHoldoutIdx !== holdoutIdx) {
            retestedHoldoutIdx = holdoutIdx;
        } else {
            activeHoldoutCursor = (holdoutIdx + 1) % samples.holdouts.length;
        }
    }

    const latestScore = roundHistory.length > 0 ? roundHistory[roundHistory.length - 1].score : null;
    const summaryDiffFindings = roundHistory
        .map(r => `【第 ${r.round} 轮盲测 · ${r.holdoutLabel} · 相似度：${r.score !== null ? `${r.score}/100` : '已评估'}】\n${r.diffNotes}`)
        .join('\n\n');

    return {
        version: 4,
        title: novelData.title,
        cutoffChapterIndex: cutoff,
        distilledAt: Date.now(),
        roundsCompleted: roundHistory.length,
        latestScore,
        roundHistory,
        processLog,
        fingerprint,
        fingerprintText,
        styleCard: currentStyleCard,
        goldenExcerpts,
        diffFindings: summaryDiffFindings,
    };
}

/**
 * Compresses & de-overfits a bloated Style DNA Bible (e.g. >3,500 chars with verbatim holdout quotes)
 * into a sharp, combat-ready 1,800 ~ 2,500-char Style Bible in 1 single API call.
 *
 * @param {{
 *   novelTitle: string,
 *   styleCard: string,
 *   fingerprintText?: string,
 *   callModel: (args: { prompt: string, systemPrompt: string, stage: string }) => Promise<string>,
 * }} params
 */
export async function compressAndDeoverfitStyleCard({ novelTitle, styleCard, fingerprintText = '', callModel }) {
    if (!styleCard || !String(styleCard).trim()) {
        throw new Error('当前没有可提纯瘦身的文风圣经');
    }
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }

    const raw = await callModel({
        stage: 'compress_deoverfit_style_card',
        systemPrompt: '你是顶尖小说编辑与提示词架构师，擅长把冗长过拟合的文风分析文档提纯为极高密度、零剧情泄露、可直接实战执行的短小精悍写作圣经。',
        prompt: [
            `请将下方《${novelTitle || '当前小说'}》目前过长/存在过拟合风险的《原著文风 DNA 圣经》（现 ${String(styleCard).length} 字），一次性去重提纯瘦身为 **1,800 ~ 2,500 字** 的实战终极版！`,
            '',
            '【严格提纯纪律】：',
            '1. **彻底清除单章过拟合原句与具体剧情道具**：删掉所有可直接被 AI 当作复读机照抄的长段原文描写（如特定颜色烤漆/特定衣裙玉石描写/某次具体对话原句），全部升华为**可泛化到未来任意新章节的通用笔法法则**！',
            '2. **完整保留所有高价值核心洞察**：务必保留段落骨相数值、视角限制、分场景内心独白语态切换（如亢奋/拉扯/静物审视分流）、角色声线寡言反差、微距白描法则、以及去否定式心理废话等真正有效的骨相原则！',
            '3. **精炼反 AI 味对照库**：将所有零散的反 AI 味案例去重合并为最具代表性的 **8~10 组短句级通用对照（❌ AI通病写法 → ✅ 原著笔法写法）**，去掉具体情节剧透。',
            '4. 总字数严格控制在 **1,800 ~ 2,500 字** 之间，用 `<style_dna>...</style_dna>` 标签包裹输出。',
            fingerprintText ? `\n【本地客观统计锚点（务必保留在模块一）】：\n${fingerprintText}\n` : '',
            '【待提纯瘦身的现有文风圣经】：',
            String(styleCard).trim(),
        ].join('\n'),
    });

    const compressed = extractTaggedSection(raw, 'style_dna');
    if (!compressed || compressed.length < 200) {
        throw new Error('提纯返回的文风圣经异常过短，已保留原版未覆盖');
    }
    return compressed;
}
