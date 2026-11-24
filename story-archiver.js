/**
 * Bounded-Concurrency (max <= 2) Full-Novel & Incremental Story Chronicle,
 * 4-Dimension Character Soul & Anti-OOC Profile, and Foreshadowing Hook Archiver.
 *
 * Supports per-slice persistence, automatic refusal/apology detection,
 * single-slice or failed-slice re-runs, and standalone re-synthesis without re-reading OK slices.
 *
 * Pure logic module: zero DOM or network dependencies. All LLM calls are delegated
 * through `callModel` (which applies the chosen API + Tavern preset).
 */

import { extractNovelStateBlock, parseChapterRangeSpec, stripNonStoryBlocks } from './parser.js';
import { cleanDistillProse, isAbortError, runBoundedPool, throwIfAborted } from './style-distiller.js';

const REFUSAL_PATTERNS = [
    /抱歉[，,。!！\s]*(?:我)?(?:无法|不能|不便)/i,
    /对不起[，,。!！\s]*(?:我)?(?:无法|不能)/i,
    /我无法(?:以[^。]*?身份|生成|处理|提供|继续|协助|满足)/i,
    /(?:安全准则|安全政策|内容政策|伦理准则).*?(?:拒绝|无法|不允许)/i,
    /(?:包含|涉及).*?(?:露骨色情|成人内容|色情内容|性内容).*?(?:无法|拒绝|不能)/i,
    /\b(?:I(?:'m| am)\s+sorry|I\s+cannot|I\s+can't|unable\s+to\s+(?:fulfill|process|generate)|safety\s+guidelines)\b/i,
];

/**
 * Shared refusal/apology detector used by both the Story Archiver and the Director Outline generator.
 * @param {string} rawText
 * @returns {boolean}
 */
export function isModelRefusalText(rawText) {
    const cleaned = cleanTagText(rawText);
    if (!cleaned) return false;
    return REFUSAL_PATTERNS.some(re => re.test(cleaned));
}

function cleanTagText(raw) {
    return cleanDistillProse(raw);
}

function extractInner(text, tagName) {
    const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const m = String(text || '').match(re);
    return m ? m[1].trim() : '';
}

function extractAllBlocks(text, tagName) {
    const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        if (m[1] && m[1].trim()) out.push(m[1].trim());
    }
    return out;
}

function isPlaceholder(text) {
    const t = String(text || '').trim();
    return !t || /^(?:无|暂无|无新增|无变动|无更新|没有|略|none|n\/a|-|—+)$/i.test(t);
}

/**
 * Inspects a single slice's model output to detect refusals, apologies, or missing structured tags.
 *
 * @param {string} rawNotes
 * @returns {{ status: 'ok' | 'refused' | 'empty', statusNote: string }}
 */
export function inspectBatchExtractionQuality(rawNotes) {
    const cleaned = cleanTagText(rawNotes);
    if (!cleaned || cleaned.length < 30) {
        return {
            status: 'empty',
            statusNote: '返回内容为空或过短，未提取出有效剧情切片',
        };
    }

    const eventsBody = extractInner(cleaned, 'batch_events');
    const charsBody = extractInner(cleaned, 'batch_characters');
    const hasRichStructuredTags = eventsBody.length >= 40 || charsBody.length >= 40;
    const hasBasicStructuredTags = eventsBody.length >= 10 || charsBody.length >= 10;
    const matchesRefusal = isModelRefusalText(cleaned);

    if (matchesRefusal && !hasRichStructuredTags) {
        return {
            status: 'refused',
            statusNote: '检测到模型道歉/拒答，未提取出本切片剧情与人物（建议切换预设或自定义 API 后单独重跑此切片）',
        };
    }
    if (!hasBasicStructuredTags && cleaned.length < 220) {
        return {
            status: 'empty',
            statusNote: '缺少 <batch_events>/<batch_characters> 结构化内容，建议重跑此切片',
        };
    }
    return {
        status: 'ok',
        statusNote: `正常提取（${cleaned.length} 字）`,
    };
}

/**
 * Groups consecutive chapters into contiguous text windows so a full novel can be read
 * thoroughly within bounded API calls (<= `maxBatches`) without splitting mid-chapter.
 */
export function planArchiveBatches(
    chapters,
    { startChapter = 1, endChapter = Infinity, targetBatchChars = 15000, maxBatches = 15 } = {},
) {
    const selected = (chapters || [])
        .filter(c => c && Number(c.index) >= startChapter && Number(c.index) <= endChapter && c.timelineRole !== 'skip')
        .sort((a, b) => a.index - b.index);

    if (selected.length === 0) return [];

    const normalized = selected.map(ch => ({
        index: Number(ch.index),
        title: String(ch.title || `第 ${ch.index} 章`),
        timelineRole: (ch.timelineRole === 'reference' || ch.timelineRole === 'flashback') ? ch.timelineRole : 'main',
        content: cleanTagText(ch.content || ''),
    })).filter(ch => ch.content.length > 0);

    if (normalized.length === 0) return [];

    const totalChars = normalized.reduce((sum, ch) => sum + ch.content.length, 0);
    const effectiveLimit = Math.max(targetBatchChars, Math.ceil(totalChars / Math.max(1, maxBatches)));

    const batches = [];
    let bucket = [];
    let bucketChars = 0;

    const flush = () => {
        if (bucket.length === 0) return;
        const text = bucket
            .map(ch => {
                const roleTag = ch.timelineRole === 'reference'
                    ? ' [基准时间线原著]'
                    : (ch.timelineRole === 'flashback' ? ' [倒叙/插叙]' : '');
                return `【第 ${ch.index} 章 · ${ch.title}${roleTag}】\n${ch.content}`;
            })
            .join('\n\n');
        batches.push({
            batchIndex: batches.length + 1,
            startChapter: bucket[0].index,
            endChapter: bucket[bucket.length - 1].index,
            chapterTitles: bucket.map(ch => ch.title),
            charCount: bucketChars,
            text,
        });
        bucket = [];
        bucketChars = 0;
    };

    for (const ch of normalized) {
        if (bucket.length > 0 && bucketChars + ch.content.length > effectiveLimit) {
            flush();
        }
        bucket.push(ch);
        bucketChars += ch.content.length;
    }
    flush();

    return batches;
}

/**
 * Parses structured `<event>` blocks from the synthesized chronicle response.
 */
export function parseChronicleEvents(rawText) {
    const cleaned = cleanTagText(rawText);
    const eventBlocks = extractAllBlocks(cleaned, 'event');
    const events = [];

    for (let i = 0; i < eventBlocks.length; i += 1) {
        const block = eventBlocks[i];
        const title = extractInner(block, 'title');
        const range = extractInner(block, 'chapters') || extractInner(block, 'range');
        const timeLabel = extractInner(block, 'time');
        const pov = extractInner(block, 'pov');
        const timelinePhaseRaw = extractInner(block, 'timeline_phase');
        const participantsRaw = extractInner(block, 'participants');
        const summary = extractInner(block, 'summary');
        const infoGap = extractInner(block, 'info_gap');
        const povKnown = extractInner(block, 'pov_known');
        const povBlindspot = extractInner(block, 'pov_blindspot');
        if (!title && !summary) continue;

        const nums = [...range.matchAll(/\d+/g)].map(m => Number(m[0])).filter(n => n > 0);
        const startChapter = nums[0] || 1;
        const endChapter = nums[nums.length - 1] || startChapter;
        const participants = participantsRaw
            ? participantsRaw.split(/[、,，/｜|\s]+/).map(s => s.trim()).filter(Boolean)
            : [];
        const timelinePhase = /reference|基准/i.test(timelinePhaseRaw)
            ? 'reference'
            : (/flashback|倒叙|插叙|外传/i.test(timelinePhaseRaw) ? 'flashback' : 'main');

        events.push({
            id: `evt_${startChapter}_${endChapter}_${i + 1}`,
            title: title || `事件 #${i + 1}`,
            chapterRange: range || (startChapter === endChapter ? `#${startChapter}` : `#${startChapter}-#${endChapter}`),
            startChapter,
            endChapter,
            timeLabel: isPlaceholder(timeLabel) ? '' : timeLabel,
            pov: isPlaceholder(pov) ? '' : pov,
            timelinePhase,
            participants,
            summary: summary || title,
            infoGap: isPlaceholder(infoGap) ? '' : infoGap,
            povKnown: isPlaceholder(povKnown) ? '' : povKnown,
            povBlindspot: isPlaceholder(povBlindspot) ? '' : povBlindspot,
        });
    }

    return events;
}

/**
 * Parses structured `<character>` blocks (with Markdown heading fallback)
 * into 4-dimension anti-OOC character soul profiles.
 */
export function parseCharacterProfiles(rawText, updatedChapter = 1) {
    const cleaned = cleanTagText(rawText);
    const blocks = extractAllBlocks(cleaned, 'character');
    const characters = [];
    const seen = new Set();

    const pushChar = ({ name, role, canonFoundation, currentAppearance, currentSituation, voiceAndQuotes, oocRedLines }) => {
        const cleanName = String(name || '').replace(/^[#*\-\d.、\s]+/, '').replace(/[*：:]+$/, '').trim();
        if (!cleanName || isPlaceholder(cleanName) || cleanName.length > 36) return;
        const normKey = cleanName.toLowerCase();
        if (seen.has(normKey)) return;
        seen.add(normKey);

        characters.push({
            id: `char_${normKey.replace(/[^\p{L}\p{N}_-]+/gu, '_')}_${characters.length + 1}`,
            name: cleanName,
            role: isPlaceholder(role) ? '' : String(role || '').trim(),
            canonFoundation: isPlaceholder(canonFoundation) ? '' : String(canonFoundation || '').trim(),
            currentAppearance: isPlaceholder(currentAppearance) ? '' : String(currentAppearance || '').trim(),
            currentSituation: isPlaceholder(currentSituation) ? '' : String(currentSituation || '').trim(),
            voiceAndQuotes: isPlaceholder(voiceAndQuotes) ? '' : String(voiceAndQuotes || '').trim(),
            oocRedLines: isPlaceholder(oocRedLines) ? '' : String(oocRedLines || '').trim(),
            updatedChapter,
        });
    };

    for (const block of blocks) {
        pushChar({
            name: extractInner(block, 'name'),
            role: extractInner(block, 'role'),
            canonFoundation: extractInner(block, 'canon_foundation'),
            currentAppearance: extractInner(block, 'current_appearance'),
            currentSituation: extractInner(block, 'current_situation'),
            voiceAndQuotes: extractInner(block, 'voice_and_quotes'),
            oocRedLines: extractInner(block, 'ooc_red_lines'),
        });
    }

    // Fallback: parse Markdown character sections if the model omitted <character> XML tags
    if (characters.length === 0 && !REFUSAL_PATTERNS.some(re => re.test(cleaned))) {
        const sections = cleaned.split(/\n(?=#{2,4}\s+|【[^】\n]{1,24}】|\*\*[^*\n]{1,20}\*\*(?:\s*[（(][^）)\n]{1,30}[）)])?\s*\n)/);
        const grabField = (sec, labelPattern) => {
            const re = new RegExp(`(?:^|\\n)[\\s\\-*•]*(?:\\*\\*)?(?:${labelPattern})(?:\\*\\*)?[：:]\\s*([\\s\\S]*?)(?=\\n[\\s\\-*•]*(?:\\*\\*)?(?:身份|定位|原作|游戏|当前|处境|原著|言行|声线|绝对|OOC|红线)|$)`, 'i');
            const m = sec.match(re);
            return m ? m[1].trim() : '';
        };
        for (const sec of sections) {
            const trimmed = sec.trim();
            if (trimmed.length < 40) continue;
            const firstLine = trimmed.split('\n')[0].trim();
            const headingMatch = firstLine.match(/^(?:#{2,4}\s+|【|\*\*)(?:\d+[.、\s]*)?([^】*（(]{1,24})(?:[】*])?(?:[（(]([^）)]+)[）)])?/);
            if (!headingMatch) continue;
            const canonFoundation = grabField(trimmed, '原作[^：:\\n]{0,12}|游戏[^：:\\n]{0,12}');
            const currentSituation = grabField(trimmed, '当前处境[^：:\\n]{0,12}|同人当前[^：:\\n]{0,12}|处境与关系');
            const voiceAndQuotes = grabField(trimmed, '原著[^：:\\n]{0,12}|言行[^：:\\n]{0,12}|声线[^：:\\n]{0,12}');
            const oocRedLines = grabField(trimmed, '绝对\\s*OOC[^：:\\n]{0,10}|OOC\\s*红线|防\\s*OOC[^：:\\n]{0,10}');
            if (canonFoundation || currentSituation || voiceAndQuotes || oocRedLines) {
                pushChar({
                    name: headingMatch[1],
                    role: headingMatch[2] || grabField(trimmed, '身份定位|身份'),
                    canonFoundation,
                    currentSituation,
                    voiceAndQuotes,
                    oocRedLines,
                });
            }
        }
    }

    return characters;
}

/**
 * Parses `<hooks>` and `<world>` sections from synthesized archive output.
 */
export function parseArchiveHooksAndWorld(rawText, defaultChapter = 1) {
    const cleaned = cleanTagText(rawText);
    const hooksInner = extractInner(cleaned, 'hooks');
    const worldInner = extractInner(cleaned, 'world');

    const hooks = [];
    if (hooksInner) {
        const lines = hooksInner
            .split('\n')
            .map(l => l.replace(/^[\s\-*•]+/, '').replace(/^(?:\d+[.、)）]\s*)+/, '').trim())
            .filter(Boolean);
        for (const line of lines) {
            if (isPlaceholder(line)) continue;
            const isResolved = /^[\[【]?(?:已填坑|已回收|回收|完成|resolved)[\]】]?/i.test(line);
            const rawContent = line
                .replace(/^[\[【]?(?:已填坑|已回收|回收|完成|resolved|待填|未解|新伏笔|伏笔|暗线|open)[\]】]?[:：\s\-—]*/i, '')
                .trim();
            if (isPlaceholder(rawContent)) continue;
            const chMatch = rawContent.match(/#(\d+)/);
            const plantedChapter = chMatch ? Number(chMatch[1]) : defaultChapter;
            hooks.push({
                id: `hook_arc_${Date.now()}_${hooks.length}_${Math.random().toString(36).slice(2, 6)}`,
                content: rawContent.replace(/\s*\(#\d+\)\s*$/, '').trim(),
                plantedChapter,
                resolvedChapter: isResolved ? defaultChapter : undefined,
                status: isResolved ? 'resolved' : 'open',
                autoExtracted: true,
            });
        }
    }

    const worldStates = [];
    if (worldInner) {
        const lines = worldInner
            .split('\n')
            .map(l => l.replace(/^[\s\-*•]+/, '').replace(/^(?:\d+[.、)）]\s*)+/, '').trim())
            .filter(Boolean);
        for (const line of lines) {
            if (isPlaceholder(line)) continue;
            const colonIdx = line.search(/[:：]/);
            if (colonIdx === -1) continue;
            const head = line.slice(0, colonIdx).trim();
            const state = line.slice(colonIdx + 1).trim();
            if (!head || isPlaceholder(state)) continue;
            const pipeIdx = head.search(/[|｜/]/);
            const category = pipeIdx !== -1 ? (head.slice(0, pipeIdx).trim() || '设定') : '设定';
            const name = pipeIdx !== -1 ? head.slice(pipeIdx + 1).trim() : head;
            if (!name) continue;
            worldStates.push({
                id: `ws_arc_${category}_${name}_ch${defaultChapter}`,
                category,
                name,
                state,
                effectiveChapter: defaultChapter,
                updatedAt: Date.now(),
            });
        }
    }

    return { hooks, worldStates };
}

function formatExistingArchiveBrief(existingLedger) {
    if (!existingLedger) return '';
    const parts = [];
    if (Array.isArray(existingLedger.chronicle) && existingLedger.chronicle.length > 0) {
        parts.push(
            '【已有剧情编年史（增量合并时请完整保留历史事件，仅追加新章节事件或修正状态）】：',
            ...existingLedger.chronicle.map(e => `- [${e.chapterRange}] ${e.title}：${e.summary}`),
        );
    }
    if (Array.isArray(existingLedger.characters) && existingLedger.characters.length > 0) {
        parts.push(
            '',
            '【已有核心人物档案（增量合并时请完整保留已有精准细节与 OOC 红线，仅补充新进展）】：',
            ...existingLedger.characters.map(c =>
                `<character><name>${c.name}</name><role>${c.role}</role><canon_foundation>${c.canonFoundation}</canon_foundation><current_situation>${c.currentSituation}</current_situation><voice_and_quotes>${c.voiceAndQuotes}</voice_and_quotes><ooc_red_lines>${c.oocRedLines}</ooc_red_lines></character>`,
            ),
        );
    }
    return parts.join('\n');
}

const READER_SYSTEM_PROMPT = [
    '你是专业长篇小说文学档案编辑，负责为后续长篇连载建立【高精度、零遗漏、绝不避重就轻】的剧情事实台账与人物行为档案。',
    '绝对纪律：',
    '1. 100% 忠实、直白、具体地记录原文实际发生的核心事件、冲突经过、交易条件与筹码变化、人物底线与关系推进的具体节点——严禁避重就轻，严禁把具体情节敷衍概括成“亲密互动”“越界接触”“特殊交易”“发生了一些事”等空洞模糊词！',
    '2. 人物笔记重点捕捉【真实说话长度、寡言/话多程度、原著原话原句、动作习惯、当前心理防线与底线变化到哪一步、绝对不会做的 OOC 行为】；绝不套用 RPG 好感标签（如 [亲密]/[厌恶]/[黑化]），绝不把松弛/算计的角色概括成“霸道总裁”；',
    '3. 清晰记录每一段的关键信息差（谁在场、谁知情、谁被蒙在鼓里、谁借此抓住了什么把柄或筹码），让后续续写和大纲策划能够精确承接、绝不写重或遗漏关键转折。',
].join('\n');

const SYNTH_SYSTEM_PROMPT = [
    '你是顶级长篇同人/原著小说总编，负责把分段剧情笔记整合成【详实、直白、零章节遗漏】的《全本剧情编年史》《核心人物4维防OOC灵魂档案》与《伏笔总账》。',
    '核心目标：让后续大纲策划与续写既不丢原作/游戏世界观硬设定，又精确掌握每一阶段实际发生了什么事、各角色底线突破到哪一步、筹码与信息差如何演进，绝不模糊敷衍、绝不跳过任何章节区间、绝不 OOC。',
    '必须严格按照指定的 XML 标签输出，不要输出无关开场白。',
].join('\n');

/**
 * Reads a single chapter batch slice, inspects it for refusals/errors, and returns a persisted slice record.
 */
export async function readSingleArchiveBatch({
    novelTitle,
    batch,
    totalBatches,
    narrativeConfig = null,
    callModel,
    signal = null,
}) {
    throwIfAborted(signal);
    const povChar = narrativeConfig?.povMode === 'strict_limited' && narrativeConfig?.povCharacter
        ? String(narrativeConfig.povCharacter).trim()
        : '';
    try {
        const raw = await callModel({
            stage: `archive_batch_${batch.batchIndex}`,
            systemPrompt: READER_SYSTEM_PROMPT,
            prompt: [
                `正在对《${novelTitle || '小说'}》第 ${batch.startChapter}~${batch.endChapter} 章（切片 ${batch.batchIndex}/${totalBatches}，约 ${batch.charCount} 字）做高精度剧情事实梳理与人物建档。`,
                '【硬性要求】：逐章/逐场如实写清具体发生了什么、人物态度与底线变化到哪一步、筹码/约定具体是什么、关键原话、当前着装与信息差；严禁使用模糊词一笔带过！',
                povChar
                    ? `【单视角信息隔离重点】：本书锁定主视角人物为「${povChar}」。请注明每段剧情的叙事视角、属于主线推进还是倒叙/他视角补完，并写清「${povChar}明确已知的事实」与「${povChar}尚不知情的幕后盲区」。`
                    : '',
                '请从下方正文提炼 4 项精细笔记，严格按顺序输出以下 4 个 XML 标签块（直接输出尖括号标签，不要加反引号）：',
                '- `<batch_events>` …… `</batch_events>`：按章节顺序详实列出本切片每个核心事件（具体章号 | 叙事视角与时间线属性[主线/倒叙] | 时间/地点 | 出场人物 | 具体发生了什么、关键对话/交易条件、人物底线或关系推进的具体结果 | 信息差：谁知情、谁被蒙在鼓里）',
                '- `<batch_characters>` …… `</batch_characters>`：逐个列出本切片登场的主要人物（姓名 | 身份与原作能力线索 | 当前外观与常服/着装细节 | 本段具体关系进度、底线变化与筹码变动 | 2~3句最能体现声线的原著原话 | 真实性格底色与行为分寸观察）',
                '- `<batch_hooks>` …… `</batch_hooks>`：本切片埋下的未解伏笔/约定/把柄/暗线，以及被回收解决的旧伏笔（注明具体章号）',
                '- `<batch_world>` …… `</batch_world>`：关键物品、地点、势力、核心设定规则的引入或变化',
                '',
                '【本切片原文】：',
                batch.text,
            ].filter(Boolean).join('\n'),
        });
        throwIfAborted(signal);

        const notes = cleanTagText(raw);
        const quality = inspectBatchExtractionQuality(notes);
        return {
            batchIndex: batch.batchIndex,
            startChapter: batch.startChapter,
            endChapter: batch.endChapter,
            chapterTitles: batch.chapterTitles || [],
            charCount: batch.charCount || batch.text?.length || 0,
            status: quality.status,
            statusNote: quality.statusNote,
            notes,
            updatedAt: Date.now(),
        };
    } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
            throw error;
        }
        return {
            batchIndex: batch.batchIndex,
            startChapter: batch.startChapter,
            endChapter: batch.endChapter,
            chapterTitles: batch.chapterTitles || [],
            charCount: batch.charCount || batch.text?.length || 0,
            status: 'error',
            statusNote: `请求出错：${error?.message || error}`,
            notes: '',
            updatedAt: Date.now(),
        };
    }
}

function planChronicleSynthesisWindows(okBatches, { maxBatchesPerWindow = 4, maxWindowChars = 16500 } = {}) {
    if (okBatches.length <= maxBatchesPerWindow) {
        const totalLen = okBatches.reduce((sum, b) => sum + String(b.notes || '').length, 0);
        if (totalLen <= maxWindowChars + 2000) {
            return [okBatches];
        }
    }
    const windows = [];
    let current = [];
    let currentChars = 0;
    for (const b of okBatches) {
        const len = String(b.notes || '').length;
        if (current.length > 0 && (current.length >= maxBatchesPerWindow || currentChars + len > maxWindowChars)) {
            windows.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(b);
        currentChars += len;
    }
    if (current.length > 0) windows.push(current);
    return windows;
}

function buildCharacterSynthesisNotes(okBatches, maxTotalChars = 28000) {
    const full = okBatches
        .map(b => `=== 切片 ${b.batchIndex}（第 ${b.startChapter}~${b.endChapter} 章）===\n${b.notes}`)
        .join('\n\n');
    if (full.length <= maxTotalChars) {
        return full;
    }
    const perSliceBudget = Math.max(900, Math.floor(maxTotalChars / Math.max(1, okBatches.length)));
    return okBatches.map(b => {
        const raw = String(b.notes || '');
        const charsSec = extractInner(raw, 'batch_characters');
        const eventsSec = extractInner(raw, 'batch_events');
        const body = (charsSec || eventsSec)
            ? [
                charsSec ? `[人物观察]\n${charsSec.slice(0, Math.floor(perSliceBudget * 0.6))}` : '',
                eventsSec ? `[剧情节点]\n${eventsSec.slice(0, Math.floor(perSliceBudget * 0.4))}` : '',
            ].filter(Boolean).join('\n')
            : raw.slice(0, perSliceBudget);
        return `=== 切片 ${b.batchIndex}（第 ${b.startChapter}~${b.endChapter} 章）===\n${body}`;
    }).join('\n\n');
}

/**
 * Synthesizes Chronicle, 4-Dim Character Soul Profiles, Hooks, and World States
 * exclusively from `status === 'ok'` slices so refused/error slices never poison synthesis.
 * Long novels (> 4 slices or > 18k note chars) automatically synthesize Chronicle in contiguous
 * chapter windows (concurrency <= 2) so no chapter span is ever truncated or dropped.
 */
export async function synthesizeArchiveFromBatches({
    novelTitle,
    batches,
    existingLedger = null,
    narrativeConfig = null,
    worldInfoContext = '',
    mode = 'full',
    callModel,
    maxConcurrency = 2,
    signal = null,
    onProgress = () => {},
}) {
    throwIfAborted(signal);
    const activeCfg = narrativeConfig || existingLedger?.narrativeConfig || null;
    const povChar = activeCfg?.povMode === 'strict_limited' && activeCfg?.povCharacter
        ? String(activeCfg.povCharacter).trim()
        : '';
    const okBatches = (batches || [])
        .filter(b => b && b.status === 'ok' && String(b.notes || '').trim())
        .sort((a, b) => (a.startChapter || 0) - (b.startChapter || 0));

    if (okBatches.length === 0) {
        throw new Error('没有可用的正常切片可供合稿（所有切片均疑似道歉或失败），请切换预设或自定义 API 后重跑切片');
    }

    const maxCoveredChapter = Math.max(...okBatches.map(b => Number(b.endChapter || 0)), 1);
    const concurrency = Math.max(1, Math.min(2, Number(maxConcurrency) || 2));
    const windows = planChronicleSynthesisWindows(okBatches);
    const isChunked = windows.length > 1;
    const totalSynthSteps = windows.length + 1;
    const existingBrief = mode === 'incremental' ? formatExistingArchiveBrief(existingLedger) : '';
    const charNotesInput = buildCharacterSynthesisNotes(okBatches);

    onProgress({
        step: 1,
        totalSteps: totalSynthSteps + 1,
        label: isChunked
            ? `正在分 ${windows.length} 个章节区间并行精细合稿《编年史 + 伏笔》与《人物灵魂档案》（覆盖全部 ${okBatches.length} 个切片，并发≤2）...`
            : `正在基于 ${okBatches.length}/${batches.length} 个正常切片并行合稿：《全本编年史 + 伏笔》 || 《核心人物 4 维灵魂档案》...`,
    });

    let completedSynth = 0;
    const synthTasks = [
        ...windows.map((winBatches, winIdx) => async () => {
            const winStart = winBatches[0].startChapter;
            const winEnd = winBatches[winBatches.length - 1].endChapter;
            const winNotes = winBatches
                .map(b => `=== 切片 ${b.batchIndex}（第 ${b.startChapter}~${b.endChapter} 章）===\n${b.notes}`)
                .join('\n\n');
            const stageName = isChunked ? `archive_synth_chronicle_win_${winIdx + 1}` : 'archive_synth_chronicle_hooks';
            const expectedEvents = isChunked ? '3~7' : '6~16';

            const raw = await callModel({
                stage: stageName,
                systemPrompt: SYNTH_SYSTEM_PROMPT,
                prompt: [
                    `请基于下方切片笔记，为《${novelTitle || '小说'}》**第 ${winStart}~${winEnd} 章**${isChunked ? `（全本分卷合稿 第 ${winIdx + 1}/${windows.length} 段）` : ''}合稿一份**详实、直白、不遗漏任何章节区间**的《剧情编年史》《伏笔总账》与《关键物品/势力状态》。`,
                    '【反模糊与防漏章硬性纪律】：',
                    `1. **100% 覆盖第 ${winStart}~${winEnd} 章**：必须按原著推进顺序完整覆盖该区间内的每一个重要阶段（每 2~5 章或每个独立关键场次单列一条），**绝不允许跳过或截断中间任何章节**！`,
                    '2. **禁止避重就轻与模糊兜底**：严禁把具体剧情敷衍写成“亲密互动”“越界接触”“特殊关系”“发生了某些事”等空泛概括词！必须直白、准确写明具体发生了什么事件、人物底线与关系推进到哪一步、交易筹码/条件与关键原话、以及谁知情/谁被蒙在鼓里！',
                    (!isChunked && existingBrief) ? `\n${existingBrief}\n` : '',
                    '严格按以下 3 个顶级 XML 块输出（直接输出尖括号标签，不要加反引号）：',
                    `- 块 1：\`<chronicle>\` …… \`</chronicle>\`（按推进顺序输出 ${expectedEvents} 个核心阶段事件，完整覆盖 #${winStart}~#${winEnd}；每个事件以 \`<event>\` 开头、\`</event>\` 结尾，内部依次包含以下单行子标签）：`,
                    `  · \`<chapters>#${winStart}-#${Math.min(winEnd, winStart + 4)}</chapters>\``,
                    '  · `<time>时间阶段或场景背景</time>`',
                    '  · `<pov>本段实际叙事视角人物（如主视角/多视角/具体角色名）</pov>`',
                    '  · `<timeline_phase>main（当前续写视角正文）、reference（已完结对照基准时间线）或 flashback（倒叙/插叙）</timeline_phase>`',
                    '  · `<title>简短精准的事件标题</title>`',
                    '  · `<participants>人物A、人物B</participants>`',
                    '  · `<summary>150~300字详实、具体、不回避关键节点的经过、底线/关系变化、筹码变动与确切结果</summary>`',
                    '  · `<info_gap>当前关键信息差（例如：谁还不知道某事、谁暗中做了什么；无则写无）</info_gap>`',
                    ...(povChar ? [
                        `  · \`<pov_known>「${povChar}」在此阶段明确亲眼/亲耳/经由文件通讯获知的事实（无则写无）</pov_known>\``,
                        `  · \`<pov_blindspot>「${povChar}」此时尚不知情、仅在幕后或他视角发生的事实（无则写无）</pov_blindspot>\``,
                    ] : []),
                    '- 块 2：`<hooks>` …… `</hooks>`（列出本区间所有重要伏笔/约定/把柄/暗线，每条一行：未解决的用 `[待填] 伏笔具体内容 (#埋下章号)`，已在后续章节回收解决的用 `[已回收] 伏笔内容 (#章号)`）',
                    '- 块 3：`<world>` …… `</world>`（列出关键物品/设备/地点/势力的最新状态，每条一行：`物品|名称：具体状态` 或 `势力|名称：具体状态`）',
                    '',
                    `【第 ${winStart}~${winEnd} 章切片分析笔记】：`,
                    winNotes,
                ].join('\n'),
            });

            completedSynth += 1;
            onProgress({
                step: completedSynth,
                totalSteps: totalSynthSteps + 1,
                label: `已完成第 ${winStart}~${winEnd} 章编年史合稿（${completedSynth}/${totalSynthSteps}）...`,
            });
            return { kind: 'chronicle', winStart, winEnd, raw };
        }),
        async () => {
            const raw = await callModel({
                stage: 'archive_synth_characters',
                systemPrompt: SYNTH_SYSTEM_PROMPT,
                prompt: [
                    `请基于下方全部正常切片的剧情与人物笔记，为《${novelTitle || '小说'}》（截至第 ${maxCoveredChapter} 章）合稿一份极度精准、绝不避重就轻的《核心人物 4 维灵魂与防 OOC 档案》。`,
                    '【核心纪律】：',
                    '- 必须直白、具体地写明每个人物截至最新章节的真实处境、底线已被突破到哪一步、手里掌握或受制于哪些具体筹码、对各方的真实态度，严禁使用“亲密关系”“某些交易”等模糊词敷衍；',
                    '- 严禁使用空泛的 RPG 好感标签（如 [亲密]/[厌恶]）或容易诱发霸总/刻板印象的夸张词；',
                    '- 必须把“原作/游戏硬设定底骨”和“本小说当前同人演进”清晰分开又无缝融合；',
                    '- 必须为每个主要人物摘录 2~3 句原著真实原话作为声线锚点，并写清其寡言/话多程度与绝对 OOC 红线！',
                    existingBrief ? `\n${existingBrief}\n` : '',
                    '严格以 `<characters>` 开头、`</characters>` 结尾输出全部核心登场人物（一般 3~8 人，直接输出尖括号标签不要加反引号；每个人物用 `<character>` 开头、`</character>` 结尾，内部依次包含以下子标签）：',
                    '· `<name>人物姓名</name>`',
                    '· `<role>身份定位（简短一行）</role>`',
                    '· `<canon_foundation>原作/游戏世界观硬设定底骨、专业能力、过往履历与性格底色</canon_foundation>`',
                    `· \`<current_appearance>截至第${maxCoveredChapter}章的稳定外貌特征与当前常服/着装锚点（如发色瞳色、常穿服饰与配饰；若已激活世界书与本小说有差异，按设定优先级清晰写定一套，避免后续混穿）</current_appearance>\``,
                    `· \`<current_situation>在本小说当前时间线（截至第${maxCoveredChapter}章）的真实处境、底线演进进度、手中筹码、被掣肘之处与对各方的具体态度</current_situation>\``,
                    '· `<voice_and_quotes>原著真实说话长度、寡言/碎碎念习惯、行动分寸与微表情特征；并直接摘录 2~3 句原著真实原话或内心独白</voice_and_quotes>`',
                    '· `<ooc_red_lines>绝对 OOC 红线：明确指出最容易把该角色写崩的 2~4 个误区</ooc_red_lines>`',
                    '',
                    worldInfoContext
                        ? `\n【已激活酒馆世界书参考（设定优先级：${activeCfg?.worldInfoPriority === 'wi_strict' ? '严格遵循世界书外貌/服装与硬设定' : '世界书提供基础底骨，若小说正文已改写则以小说为准'}）】：\n${String(worldInfoContext).slice(0, 6000)}\n`
                        : '',
                    '【全部正常切片分析笔记】：',
                    charNotesInput,
                ].filter(Boolean).join('\n'),
            });

            completedSynth += 1;
            onProgress({
                step: completedSynth,
                totalSteps: totalSynthSteps + 1,
                label: `已完成核心人物 4 维灵魂档案合稿（${completedSynth}/${totalSynthSteps}）...`,
            });
            return { kind: 'characters', raw };
        },
    ];

    const results = await runBoundedPool(synthTasks, concurrency, { signal });
    throwIfAborted(signal);
    const chronicleChunks = results.filter(r => r.kind === 'chronicle');
    const charactersRaw = results.find(r => r.kind === 'characters')?.raw || '';

    const parsedChronicle = [];
    const seenEvents = new Set();
    const hookMap = new Map();
    const worldMap = new Map();

    for (const chunk of chronicleChunks) {
        const events = parseChronicleEvents(chunk.raw);
        for (const evt of events) {
            const key = `${evt.chapterRange}|${evt.title}`.toLowerCase();
            if (seenEvents.has(key)) continue;
            seenEvents.add(key);
            parsedChronicle.push({
                ...evt,
                id: `evt_${evt.startChapter}_${evt.endChapter}_${parsedChronicle.length + 1}`,
            });
        }
        const { hooks, worldStates } = parseArchiveHooksAndWorld(chunk.raw, chunk.winEnd || maxCoveredChapter);
        for (const h of hooks) {
            const normKey = h.content.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase().slice(0, 28);
            if (!normKey) continue;
            const prev = hookMap.get(normKey);
            if (!prev || (prev.status !== 'resolved' && h.status === 'resolved')) {
                hookMap.set(normKey, h);
            }
        }
        for (const ws of worldStates) {
            worldMap.set(`${ws.category}|${ws.name}`.toLowerCase(), ws);
        }
    }

    const parsedHooks = [...hookMap.values()];
    const parsedWorld = [...worldMap.values()];
    const parsedCharacters = parseCharacterProfiles(charactersRaw, maxCoveredChapter);

    const charsWarning = parsedCharacters.length === 0
        ? `⚠️ 人物档案合稿未解析出人物（原始回复开头：${cleanTagText(charactersRaw).slice(0, 140)}）`
        : `提炼 ${parsedCharacters.length} 位核心人物防 OOC 档案（${parsedCharacters.map(c => c.name).join('、')}）`;

    const synthLogEntry = {
        id: 'synth_complete',
        title: `总合稿完成 · ${parsedChronicle.length} 条编年史 · ${parsedCharacters.length} 位人物 · ${parsedHooks.length} 条伏笔`,
        status: parsedCharacters.length > 0 && parsedChronicle.length > 0 ? 'done' : 'warn',
        summary: `基于 ${okBatches.length}/${batches.length} 个正常切片${isChunked ? `（分 ${windows.length} 个章节区间精细合稿）` : ''}覆盖至第 ${maxCoveredChapter} 章。${charsWarning}`,
        detail: [
            `【编年史事件】${parsedChronicle.map(e => `${e.chapterRange} ${e.title}`).join('；') || '（无）'}`,
            `【核心人物】${parsedCharacters.map(c => c.name).join('、') || '（未解析出，原始输出见下方）'}`,
            parsedCharacters.length === 0 ? `\n【人物合稿原始返回】\n${cleanTagText(charactersRaw).slice(0, 1500)}` : '',
        ].filter(Boolean).join('\n'),
    };

    onProgress({
        step: totalSynthSteps + 1,
        totalSteps: totalSynthSteps + 1,
        label: synthLogEntry.title,
        logEntry: synthLogEntry,
    });

    return {
        chronicle: parsedChronicle,
        characters: parsedCharacters,
        hooks: parsedHooks,
        worldStates: parsedWorld,
        lastArchivedChapter: maxCoveredChapter,
        archivedAt: Date.now(),
        synthLogEntry,
    };
}

/**
 * Runs the bounded-concurrency (<= 2) full-novel or incremental Story Chronicle,
 * 4-Dimension Character Soul & Anti-OOC Profile, and Foreshadowing Hook Archiver.
 * Per-slice refusals/errors are recorded cleanly on each slice instead of aborting the run.
 */
export async function runStoryAndCharacterArchivePipeline({
    novelData,
    continuedChapters = [],
    existingLedger = null,
    narrativeConfig = null,
    worldInfoContext = '',
    mode = 'full',
    callModel,
    maxConcurrency = 2,
    signal = null,
    onSliceCompleted = null,
    onProgress = () => {},
}) {
    throwIfAborted(signal);
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }

    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.chapters?.length || 0);
    const origChapters = (novelData?.chapters || []).filter(c => c && c.index >= 1 && c.index <= cutoff);
    const allChapters = [...origChapters, ...(continuedChapters || [])]
        .filter(c => c && c.index >= 1 && String(c.content || '').trim())
        .sort((a, b) => a.index - b.index);

    if (allChapters.length === 0) {
        throw new Error('没有可供归档总结的章节内容，请先导入原著小说');
    }

    const maxAvailableChapter = allChapters[allChapters.length - 1].index;
    const lastArchived = Number(existingLedger?.lastArchivedChapter || 0);
    const isIncremental = mode === 'incremental' && lastArchived > 0 && lastArchived < maxAvailableChapter;
    const startChapter = isIncremental ? lastArchived + 1 : 1;

    const plannedBatches = planArchiveBatches(allChapters, {
        startChapter,
        endChapter: maxAvailableChapter,
        targetBatchChars: 15000,
        maxBatches: 15,
    });

    if (plannedBatches.length === 0) {
        throw new Error('所有章节已完成归档，暂无新增未总结章节');
    }

    const existingBatches = isIncremental && Array.isArray(existingLedger?.archiveBatches)
        ? existingLedger.archiveBatches
        : [];
    const batchIndexOffset = existingBatches.length;
    const batchesToRun = plannedBatches.map((b, i) => ({
        ...b,
        batchIndex: batchIndexOffset + i + 1,
    }));

    const concurrency = Math.max(1, Math.min(2, Number(maxConcurrency) || 2));
    const totalSteps = batchesToRun.length + 2;
    let completedSteps = 0;
    const processLog = [];

    onProgress({
        step: 0,
        totalSteps,
        label: `准备${isIncremental ? '增量' : '全本'}通读《${novelData?.title || '当前小说'}》第 ${startChapter}~${maxAvailableChapter} 章（共分 ${batchesToRun.length} 个切片，并发上限 ≤ ${concurrency}）...`,
    });

    const batchTasks = batchesToRun.map(batch => async () => {
        const resultSlice = await readSingleArchiveBatch({
            novelTitle: novelData?.title,
            batch,
            totalBatches: batchIndexOffset + batchesToRun.length,
            narrativeConfig: narrativeConfig || existingLedger?.narrativeConfig || null,
            callModel,
            signal,
        });
        if (typeof onSliceCompleted === 'function') {
            try { await onSliceCompleted(resultSlice); } catch { /* ignore incremental save error */ }
        }
        completedSteps += 1;
        const statusIcon = resultSlice.status === 'ok' ? '✅' : (resultSlice.status === 'refused' ? '⚠️' : '❌');
        const entry = {
            id: `batch_${resultSlice.batchIndex}`,
            title: `${statusIcon} 切片 ${resultSlice.batchIndex}/${batchIndexOffset + batchesToRun.length} · 第 ${resultSlice.startChapter}~${resultSlice.endChapter} 章（${resultSlice.charCount} 字）`,
            status: resultSlice.status,
            summary: resultSlice.statusNote,
            detail: resultSlice.notes || resultSlice.statusNote,
        };
        processLog.push(entry);
        onProgress({
            step: completedSteps,
            totalSteps,
            label: `${statusIcon} 完成切片 ${resultSlice.batchIndex}/${batchIndexOffset + batchesToRun.length}（第 ${resultSlice.startChapter}~${resultSlice.endChapter} 章）：${resultSlice.statusNote}`,
            logEntry: entry,
        });
        return resultSlice;
    });

    const newSliceResults = await runBoundedPool(batchTasks, concurrency, { signal });
    throwIfAborted(signal);
    const allSlices = [...existingBatches, ...newSliceResults].sort((a, b) => a.batchIndex - b.batchIndex);
    const failedCount = allSlices.filter(b => b.status !== 'ok').length;

    const synth = await synthesizeArchiveFromBatches({
        novelTitle: novelData?.title,
        batches: allSlices,
        existingLedger,
        narrativeConfig: narrativeConfig || existingLedger?.narrativeConfig || null,
        worldInfoContext,
        mode: isIncremental ? 'incremental' : 'full',
        callModel,
        maxConcurrency: concurrency,
        signal,
        onProgress: ({ step, totalSteps: synthTotal, label, logEntry }) => {
            onProgress({
                step: batchesToRun.length + step,
                totalSteps: batchesToRun.length + (synthTotal || 2),
                label,
                logEntry,
            });
        },
    });
    processLog.push(synth.synthLogEntry);

    return {
        batches: allSlices,
        chronicle: synth.chronicle,
        characters: synth.characters,
        hooks: synth.hooks,
        worldStates: synth.worldStates,
        lastArchivedChapter: Math.max(maxAvailableChapter, synth.lastArchivedChapter),
        archivedAt: synth.archivedAt,
        processLog,
        failedBatchCount: failedCount,
    };
}

/**
 * Re-runs one specific slice (or a list of failed/refused slice indices) using the latest chapters
 * and current API + Preset, without touching any already-successful slices.
 */
export async function rerunArchiveBatches({
    novelData,
    continuedChapters = [],
    existingBatches = [],
    targetBatchIndices = [],
    narrativeConfig = null,
    callModel,
    maxConcurrency = 2,
    signal = null,
    onProgress = () => {},
}) {
    throwIfAborted(signal);
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }
    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.chapters?.length || 0);
    const origChapters = (novelData?.chapters || []).filter(c => c && c.index >= 1 && c.index <= cutoff);
    const allChapters = [...origChapters, ...(continuedChapters || [])]
        .filter(c => c && c.index >= 1 && String(c.content || '').trim())
        .sort((a, b) => a.index - b.index);

    const targets = (existingBatches || []).filter(b => targetBatchIndices.includes(b.batchIndex));
    if (targets.length === 0) {
        throw new Error('未找到需要重跑的切片记录');
    }

    const concurrency = Math.max(1, Math.min(2, Number(maxConcurrency) || 2));
    const totalBatches = existingBatches.length;
    let doneCount = 0;

    const tasks = targets.map(slice => async () => {
        const rangeChapters = allChapters.filter(
            c => c.index >= slice.startChapter && c.index <= slice.endChapter,
        );
        const text = rangeChapters
            .map(ch => `【第 ${ch.index} 章 · ${ch.title}】\n${cleanTagText(ch.content || '')}`)
            .join('\n\n');
        if (!text.trim()) {
            throw new Error(`找不到第 ${slice.startChapter}~${slice.endChapter} 章的原著文本`);
        }

        const updated = await readSingleArchiveBatch({
            novelTitle: novelData?.title,
            batch: {
                batchIndex: slice.batchIndex,
                startChapter: slice.startChapter,
                endChapter: slice.endChapter,
                chapterTitles: rangeChapters.map(c => c.title),
                charCount: text.length,
                text,
            },
            totalBatches,
            narrativeConfig,
            callModel,
            signal,
        });
        doneCount += 1;
        const icon = updated.status === 'ok' ? '✅' : (updated.status === 'refused' ? '⚠️' : '❌');
        onProgress({
            step: doneCount,
            totalSteps: targets.length,
            label: `${icon} 切片 #${updated.batchIndex}（第 ${updated.startChapter}~${updated.endChapter} 章）重跑完成：${updated.statusNote}`,
        });
        return updated;
    });

    const refreshed = await runBoundedPool(tasks, concurrency, { signal });
    throwIfAborted(signal);
    const byIdx = new Map(existingBatches.map(b => [b.batchIndex, b]));
    for (const item of refreshed) {
        byIdx.set(item.batchIndex, item);
    }
    const mergedBatches = [...byIdx.values()].sort((a, b) => a.batchIndex - b.batchIndex);
    return {
        batches: mergedBatches,
        refreshed,
    };
}

/**
 * Automatically analyzes a novel's chapter digest in 1 single LLM call to detect:
 * - whether it is multi-POV or single-POV (and who the continuing POV character is),
 * - whether it contains an earlier completed reference timeline + an unfinished parallel POV branch,
 * - exact chapter ranges for `reference` / `main` / `flashback` / `skip`,
 * - initial `referenceCursorChapter` where the main branch has caught up to the reference timeline.
 */
export async function detectNovelNarrativeStructure({
    novelData,
    continuedChapters = [],
    callModel,
    signal = null,
}) {
    throwIfAborted(signal);
    if (!novelData?.chapters?.length) {
        throw new Error('请先导入原著小说后再执行自动识别');
    }
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }

    const chapters = [...novelData.chapters].sort((a, b) => Number(a.index) - Number(b.index));
    const total = chapters.length;
    const perHead = total > 160 ? 60 : (total > 80 ? 95 : 140);
    const perTail = total > 160 ? 40 : (total > 80 ? 65 : 90);

    const digestLines = chapters.map(ch => {
        const clean = stripNonStoryBlocks(ch.content || '').replace(/\s+/g, ' ').trim();
        const head = clean.slice(0, perHead);
        const tail = clean.length > perHead + 20 ? clean.slice(-perTail) : '';
        return `#${ch.index}《${ch.title}》(${ch.wordCount || clean.length}字)：${head}${tail ? ` …… ${tail}` : ''}`;
    });

    let digestText = digestLines.join('\n');
    if (digestText.length > 26000) {
        digestText = `${digestText.slice(0, 13000)}\n……（中段省略）……\n${digestText.slice(-13000)}`;
    }

    const continuedHint = (continuedChapters || []).length > 0
        ? `\n【已有 AI 续写最新章摘要】：${stripNonStoryBlocks(continuedChapters[continuedChapters.length - 1].content || '').replace(/\s+/g, ' ').trim().slice(0, 600)}`
        : '';

    const systemPrompt = [
        '你是专业长篇小说结构与叙事视角分析师。',
        '你的任务是根据整本书各章的标题和首尾片段，自动判断：',
        '1. 本书是【普通单线/群像正叙】，还是【双视角/平行视角拼接】（即前面有一段某视角已完结的完整原著，后面切换成另一个视角重写/补完同一段时期却半途断更）；',
        '2. 紧接着后续要继续写下去的主角/叙事视角是谁（是否应开启严格单视角限制）；',
        '3. 各章节区间分别属于 `reference`（已完结对照基准视角）、`main`（当前要继续往后写的主线视角）、`flashback`（纯倒叙/番外）或 `skip`（作者感言/废稿）；',
        '4. 若存在双视角平行结构，目前主线最后一章（含已有续写）的时间线已经推进对齐到基准时间线的第几章（`reference_cursor`）。',
        '必须严格按 XML 标签输出，不要输出多余寒暄。',
    ].join('\n');

    const prompt = [
        `请分析小说《${novelData.title || '当前小说'}》（共 ${total} 章）的叙事结构与时间线：`,
        '',
        '严格以 `<narrative_structure>` 开头、`</narrative_structure>` 结尾输出分析结果（直接输出尖括号标签不要加反引号），内部依次包含：',
        '· `<pov_mode>strict_limited（单视角）或 auto（多视角/全知）</pov_mode>`',
        '· `<pov_character>接下来要继续续写的核心视角人物姓名（若为多视角则留空）</pov_character>`',
        '· `<pov_person>first_person（第一人称）、third_limited（第三人称限制视角）或 follow_original（跟随原著）</pov_person>`',
        '· `<reference_mode>true（存在“先写完A视角、后切换B视角未写完”的平行双线）或 false（普通单线顺序推进）</reference_mode>`',
        '· `<reference_label>若 reference_mode 为 true，填写基准视角名称（如：原主视角线），否则留空</reference_label>`',
        '· `<reference_ranges>属于已完结基准时间线的章号区间（如 1-77；没有则写 无）</reference_ranges>`',
        `· \`<main_ranges>属于当前要继续往下写的主线章节区间（如 78-135；普通单线则写 1-${total}）</main_ranges>\``,
        '· `<flashback_ranges>纯倒叙/番外章节区间（没有则写 无）</flashback_ranges>`',
        '· `<skip_ranges>非正文/作者声明/废稿章节区间（没有则写 无）</skip_ranges>`',
        '· `<reference_cursor>若 reference_mode 为 true，写出主线结尾目前已经对齐到基准时间线的第几章（纯数字，如 18 或 75；无法判断写 0）</reference_cursor>`',
        '· `<reasoning>一句话说明判断依据（说明分界点在哪个章节以及理由）</reasoning>`',
        '',
        '【全书分章首尾速览】：',
        digestText,
        continuedHint,
    ].filter(Boolean).join('\n');

    const raw = await callModel({
        stage: 'auto_detect_narrative_structure',
        systemPrompt,
        prompt,
    });
    throwIfAborted(signal);

    const cleaned = cleanDistillProse(raw);
    if (isModelRefusalText(cleaned) && !/<narrative_structure>/i.test(cleaned)) {
        throw new Error(`模型返回了拒答内容：${cleaned.slice(0, 100)}`);
    }

    const inner = extractInner(cleaned, 'narrative_structure') || cleaned;
    const povModeRaw = extractInner(inner, 'pov_mode');
    const povCharacterRaw = extractInner(inner, 'pov_character');
    const povPersonRaw = extractInner(inner, 'pov_person');
    const refModeRaw = extractInner(inner, 'reference_mode');
    const refLabelRaw = extractInner(inner, 'reference_label');
    const refRangesRaw = extractInner(inner, 'reference_ranges');
    const mainRangesRaw = extractInner(inner, 'main_ranges');
    const fbRangesRaw = extractInner(inner, 'flashback_ranges');
    const skipRangesRaw = extractInner(inner, 'skip_ranges');
    const refCursorRaw = extractInner(inner, 'reference_cursor');
    const reasoning = extractInner(inner, 'reasoning');

    const povCharacter = isPlaceholder(povCharacterRaw) ? '' : povCharacterRaw.trim();
    const povMode = (/strict/i.test(povModeRaw) && povCharacter) ? 'strict_limited' : 'auto';
    const povPerson = /first_person/i.test(povPersonRaw)
        ? 'first_person'
        : (/third_limited/i.test(povPersonRaw) ? 'third_limited' : 'follow_original');

    const referenceIndices = isPlaceholder(refRangesRaw) ? [] : parseChapterRangeSpec(refRangesRaw, total);
    const mainIndices = isPlaceholder(mainRangesRaw) ? [] : parseChapterRangeSpec(mainRangesRaw, total);
    const flashbackIndices = isPlaceholder(fbRangesRaw) ? [] : parseChapterRangeSpec(fbRangesRaw, total);
    const skipIndices = isPlaceholder(skipRangesRaw) ? [] : parseChapterRangeSpec(skipRangesRaw, total);

    const referenceTimelineMode = /^true$/i.test(refModeRaw.trim()) && referenceIndices.length > 0 && mainIndices.length > 0;
    const cursorMatch = refCursorRaw.match(/\d+/);
    const referenceCursorChapter = cursorMatch ? Math.min(total, Math.max(0, Number(cursorMatch[0]))) : 0;

    return {
        narrativeConfig: {
            povMode,
            povCharacter,
            povPerson,
            referenceTimelineMode,
            referencePovLabel: isPlaceholder(refLabelRaw) ? '' : refLabelRaw.trim(),
            referenceCursorChapter: referenceTimelineMode ? referenceCursorChapter : 0,
            strictTimelineOrder: true,
            excludeFlashbackFromAnchor: true,
        },
        referenceIndices,
        mainIndices,
        flashbackIndices,
        skipIndices,
        reasoning: isPlaceholder(reasoning) ? '' : reasoning.trim(),
    };
}

/**
 * Lightweight 1-call fallback chapter summarizer that produces a standard `<novel_state>` record
 * whenever a finished continued chapter omitted `<novel_state>` (e.g. preset stopped at `</game>`).
 */
export async function summarizeSingleChapterState({
    novelTitle = '当前小说',
    chapterIndex = 1,
    chapterTitle = '',
    chapterText = '',
    ledger = null,
    callModel,
    signal = null,
}) {
    throwIfAborted(signal);
    if (typeof callModel !== 'function') {
        throw new Error('缺少可用的模型调用函数 callModel');
    }
    const cleanBody = cleanTagText(chapterText);
    if (!cleanBody || cleanBody.length < 80) {
        throw new Error('章节正文过短，跳过单章自动总结');
    }

    const nCfg = ledger?.narrativeConfig || {};
    const refAutoOn = Boolean(nCfg.referenceTimelineMode && nCfg.autoAdvanceRefCursor !== false);
    const curRefCursor = Number(nCfg.referenceCursorChapter || 0);
    const openHooks = (ledger?.hooks || []).filter(h => h && h.status !== 'resolved').slice(-10);

    const systemPrompt = [
        '你是精准的长篇小说单章台账速记员，负责将刚写完的一章正文提炼为结构化 `<novel_state>` 存档记录。',
        '必须客观、直白、准确写清本章核心事件、人物处境/着装变化与伏笔推进，严禁模糊敷衍，只输出 `<novel_state>...</novel_state>` XML 块，不要输出额外解释。',
    ].join('\n');

    const promptParts = [
        `请为《${novelTitle}》第 ${chapterIndex} 章${chapterTitle ? `（${chapterTitle}）` : ''}输出完整闭合的 \`<novel_state>...</novel_state>\` 存档块（以 \`<novel_state>\` 开头、\`</novel_state>\` 结尾，直接输出尖括号标签不要加反引号）：`,
        `- \`<chapter_summary>第 ${chapterIndex} 章的具体核心事件经过与结果（60~140字，写明地点、出场人物、关键进展，绝不空泛）</chapter_summary>\``,
        '- `<worldbook>` …… `</worldbook>` 内按行写：`- 人物|角色名：本章结束时的最新处境/持有物/关系变化（仅写有变动的；无则写无）`；有换装再写 `- 外观|角色名：本章发生的着装或外观变化（无变化省略）`',
        '- `<hooks>` …… `</hooks>` 内按行写：`- [新伏笔] 本章新埋下的悬念、约定或把柄（无则写无）` 与 `- [已填坑] 本章回收或解决的旧伏笔（尽量沿用下方原话；无则写无）`',
        ...(refAutoOn
            ? [`- \`<ref_cursor>写完本章后已对齐覆盖的【${nCfg.referencePovLabel || '基准时间线'}】最大章号（纯数字，当前为 ${curRefCursor}；若本章推进并覆盖了后续基准章节请填新章号，否则保持 ${curRefCursor}）</ref_cursor>\``]
            : []),
    ];

    if (openHooks.length > 0) {
        promptParts.push('', '【当前待填伏笔列表（用于判断哪些在本章已被回收）】：');
        for (const h of openHooks) {
            promptParts.push(`- (#${h.plantedChapter || 1}) ${h.content}`);
        }
    }

    promptParts.push('', '【本章完整正文】：', cleanBody.slice(0, 12000));

    const raw = await callModel({
        stage: `fallback_chapter_summary_${chapterIndex}`,
        systemPrompt,
        prompt: promptParts.join('\n'),
    });
    throwIfAborted(signal);

    const extracted = extractNovelStateBlock(raw);
    if (extracted.hasState) {
        return extracted;
    }

    const cleanedRaw = cleanDistillProse(raw);
    if (isModelRefusalText(cleanedRaw)) {
        throw new Error(`单章自动总结触发模型拒答：${cleanedRaw.slice(0, 100)}`);
    }

    // Fallback: if model returned plain concise summary without XML wrapper, store it cleanly
    const plainSummary = cleanedRaw.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
    if (plainSummary.length >= 20 && plainSummary.length <= 420 && !isModelRefusalText(plainSummary)) {
        return {
            hasState: true,
            cleanText: '',
            summary: plainSummary.slice(0, 220),
            worldUpdates: [],
            appearanceUpdates: [],
            hooks: [],
            refCursor: null,
        };
    }
    throw new Error('单章自动总结未返回有效的 <novel_state> 结构');
}
