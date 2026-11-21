/**
 * Bounded-Concurrency (max <= 2) Full-Novel & Incremental Story Chronicle,
 * 4-Dimension Character Soul & Anti-OOC Profile, and Foreshadowing Hook Archiver.
 *
 * Pure logic module: zero DOM or network dependencies. All LLM calls are delegated
 * through `callModel` (which wraps requests in the user's selected Tavern preset).
 */

import { stripNonStoryBlocks } from './parser.js';
import { runBoundedPool } from './style-distiller.js';

function cleanTagText(raw) {
    return stripNonStoryBlocks(raw)
        .replace(/<\/?game>/gi, '')
        .trim();
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
 * Groups consecutive chapters into contiguous text windows so a full novel can be read
 * thoroughly within bounded API calls (<= `maxBatches`) without splitting mid-chapter.
 *
 * @param {Array<{ index: number, title: string, content: string }>} chapters
 * @param {{ startChapter?: number, endChapter?: number, targetBatchChars?: number, maxBatches?: number }} [options]
 */
export function planArchiveBatches(
    chapters,
    { startChapter = 1, endChapter = Infinity, targetBatchChars = 15000, maxBatches = 12 } = {},
) {
    const selected = (chapters || [])
        .filter(c => c && Number(c.index) >= startChapter && Number(c.index) <= endChapter)
        .sort((a, b) => a.index - b.index);

    if (selected.length === 0) return [];

    const normalized = selected.map(ch => ({
        index: Number(ch.index),
        title: String(ch.title || `第 ${ch.index} 章`),
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
            .map(ch => `【第 ${ch.index} 章 · ${ch.title}】\n${ch.content}`)
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
 *
 * @param {string} rawText
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
        const participantsRaw = extractInner(block, 'participants');
        const summary = extractInner(block, 'summary');
        const infoGap = extractInner(block, 'info_gap');
        if (!title && !summary) continue;

        const nums = [...range.matchAll(/\d+/g)].map(m => Number(m[0])).filter(n => n > 0);
        const startChapter = nums[0] || 1;
        const endChapter = nums[nums.length - 1] || startChapter;
        const participants = participantsRaw
            ? participantsRaw.split(/[、,，/｜|\s]+/).map(s => s.trim()).filter(Boolean)
            : [];

        events.push({
            id: `evt_${startChapter}_${endChapter}_${i + 1}`,
            title: title || `事件 #${i + 1}`,
            chapterRange: range || (startChapter === endChapter ? `#${startChapter}` : `#${startChapter}-#${endChapter}`),
            startChapter,
            endChapter,
            timeLabel: isPlaceholder(timeLabel) ? '' : timeLabel,
            participants,
            summary: summary || title,
            infoGap: isPlaceholder(infoGap) ? '' : infoGap,
        });
    }

    return events;
}

/**
 * Parses structured `<character>` blocks into 4-dimension anti-OOC character soul profiles.
 *
 * @param {string} rawText
 * @param {number} [updatedChapter=1]
 */
export function parseCharacterProfiles(rawText, updatedChapter = 1) {
    const cleaned = cleanTagText(rawText);
    const blocks = extractAllBlocks(cleaned, 'character');
    const characters = [];
    const seen = new Set();

    for (const block of blocks) {
        const name = extractInner(block, 'name');
        if (!name || isPlaceholder(name)) continue;
        const normKey = name.toLowerCase();
        if (seen.has(normKey)) continue;
        seen.add(normKey);

        const role = extractInner(block, 'role');
        const canonFoundation = extractInner(block, 'canon_foundation');
        const currentSituation = extractInner(block, 'current_situation');
        const voiceAndQuotes = extractInner(block, 'voice_and_quotes');
        const oocRedLines = extractInner(block, 'ooc_red_lines');

        characters.push({
            id: `char_${normKey.replace(/[^\p{L}\p{N}_-]+/gu, '_')}_${characters.length + 1}`,
            name,
            role: isPlaceholder(role) ? '' : role,
            canonFoundation: isPlaceholder(canonFoundation) ? '' : canonFoundation,
            currentSituation: isPlaceholder(currentSituation) ? '' : currentSituation,
            voiceAndQuotes: isPlaceholder(voiceAndQuotes) ? '' : voiceAndQuotes,
            oocRedLines: isPlaceholder(oocRedLines) ? '' : oocRedLines,
            updatedChapter,
        });
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

/**
 * Runs the bounded-concurrency (<= 2) full-novel or incremental Story Chronicle,
 * 4-Dimension Character Soul & Anti-OOC Profile, and Foreshadowing Hook Archiver.
 *
 * @param {{
 *   novelData: { title: string, cutoffChapterIndex: number, totalChapters: number, chapters: Array<{ index: number, title: string, content: string }> },
 *   continuedChapters?: Array<{ index: number, title: string, content: string }>,
 *   existingLedger?: any,
 *   mode?: 'full' | 'incremental',
 *   callModel: (args: { prompt: string, systemPrompt: string, stage: string }) => Promise<string>,
 *   maxConcurrency?: number,
 *   onProgress?: (info: { step: number, totalSteps: number, label: string, logEntry?: any }) => void,
 * }} params
 */
export async function runStoryAndCharacterArchivePipeline({
    novelData,
    continuedChapters = [],
    existingLedger = null,
    mode = 'full',
    callModel,
    maxConcurrency = 2,
    onProgress = () => {},
}) {
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

    const batches = planArchiveBatches(allChapters, {
        startChapter,
        endChapter: maxAvailableChapter,
        targetBatchChars: 15000,
        maxBatches: 12,
    });

    if (batches.length === 0) {
        throw new Error('所有章节已完成归档，暂无新增未总结章节');
    }

    const concurrency = Math.max(1, Math.min(2, Number(maxConcurrency) || 2));
    const totalSteps = batches.length + 2;
    let completedSteps = 0;
    const processLog = [];

    const readerSystem = [
        '你是专业长篇小说总编与人物档案分析专家，正在通读小说章节并提取高度保真的客观剧情与人物行为笔记。',
        '绝对纪律：',
        '1. 100% 客观忠于原文，绝不脑补、绝不套用 RPG 好感度标签（严禁写 [亲密]/[厌恶]/[黑化] 等词），绝不把松弛/算计的角色概括成“霸道总裁/不择手段的偏执狂”；',
        '2. 人物笔记必须重点捕捉【真实说话方式、寡言/话多程度、原话原句、微表情/动作习惯、绝对不会做的 OOC 行为】；',
        '3. 完整如实记录原文中的冲突、交易、筹码与信息差（谁知道什么、谁被蒙在鼓里），不得因内容敏感而回避或篡改事实。',
    ].join('\n');

    const synthSystem = [
        '你是顶级长篇同人/原著小说总编，负责把分段阅读笔记整合成可供 AI 续写直接参照的《全本剧情编年史》《人物4维防OOC灵魂档案》与《伏笔总账》。',
        '核心目标：让后续 AI 续写既不丢原作/游戏世界观硬设定，又 100% 还原这篇小说作者笔下独特的人物性格与克制质感，绝不 OOC、绝不跑成网文霸总或通用模板。',
        '必须严格按照指定的 XML 标签输出，不要输出无关开场白。',
    ].join('\n');

    onProgress({
        step: 0,
        totalSteps,
        label: `准备${isIncremental ? '增量' : '全本'}通读《${novelData?.title || '当前小说'}》第 ${startChapter}~${maxAvailableChapter} 章（共分 ${batches.length} 批，并发上限 ≤ ${concurrency}）...`,
    });

    // Stage 1: Bounded-concurrency (<= 2) batch reading
    const batchTasks = batches.map(batch => async () => {
        const raw = await callModel({
            stage: `archive_batch_${batch.batchIndex}`,
            systemPrompt: readerSystem,
            prompt: [
                `正在阅读《${novelData?.title || '小说'}》第 ${batch.startChapter}~${batch.endChapter} 章（批次 ${batch.batchIndex}/${batches.length}，约 ${batch.charCount} 字）。`,
                '请从下方正文提炼 4 项精细笔记，使用以下标签输出：',
                '<batch_events>',
                '（按时间顺序列出本批次关键事件：章号范围 | 时间/地点 | 出场人物 | 客观经过与结果 | 信息差/谁不知情）',
                '</batch_events>',
                '<batch_characters>',
                '（逐个列出本批次登场的主要人物：姓名 | 身份与原作能力线索 | 本段关系与筹码变化 | 2~3句最能体现声线的原著原话 | 真实性格底色与行为分寸观察）',
                '</batch_characters>',
                '<batch_hooks>',
                '（本批次埋下的未解伏笔/约定/暗线，以及被回收解决的旧伏笔，注明章号）',
                '</batch_hooks>',
                '<batch_world>',
                '（关键物品、地点、势力、核心设定规则的引入或变化）',
                '</batch_world>',
                '',
                '【本批次小说原文】：',
                batch.text,
            ].join('\n'),
        });

        const cleaned = cleanTagText(raw);
        completedSteps += 1;
        const entry = {
            id: `batch_${batch.batchIndex}`,
            title: `批次 ${batch.batchIndex}/${batches.length} · 第 ${batch.startChapter}~${batch.endChapter} 章（${batch.charCount} 字）`,
            status: 'done',
            summary: `已提炼本批次事件、人物声线与伏笔笔记（${cleaned.length} 字）`,
            detail: cleaned,
        };
        processLog.push(entry);
        onProgress({
            step: completedSteps,
            totalSteps,
            label: `已完成批次 ${batch.batchIndex}/${batches.length}（第 ${batch.startChapter}~${batch.endChapter} 章）精细阅读`,
            logEntry: entry,
        });
        return { batch, notes: cleaned };
    });

    const batchResults = await runBoundedPool(batchTasks, concurrency);

    const combinedNotes = batchResults
        .map(r => `=== 批次 ${r.batch.batchIndex}（第 ${r.batch.startChapter}~${r.batch.endChapter} 章）===\n${r.notes}`)
        .join('\n\n');
    const existingBrief = isIncremental ? formatExistingArchiveBrief(existingLedger) : '';

    // Stage 2: 2-way parallel synthesis (<= 2 concurrency): 2A Chronicle+Hooks+World || 2B 4-Dim Character Soul Profiles
    onProgress({
        step: completedSteps,
        totalSteps,
        label: '正在并行合稿：《全本剧情编年史 + 伏笔总账》 || 《核心人物 4 维灵魂与防 OOC 档案》...',
    });

    const [chronicleRaw, charactersRaw] = await runBoundedPool([
        () => callModel({
            stage: 'archive_synth_chronicle_hooks',
            systemPrompt: synthSystem,
            prompt: [
                `请基于下方全部批次阅读笔记，为《${novelData?.title || '小说'}》（截至第 ${maxAvailableChapter} 章）合稿一份精细、客观、按时间顺序排列的《全本剧情编年史》《伏笔总账》与《关键物品/势力状态》。`,
                existingBrief ? `\n${existingBrief}\n` : '',
                '严格按以下 XML 标签输出：',
                '<chronicle>',
                '（按时间顺序输出 6~18 个核心阶段事件，每个事件严格包裹在 <event>...</event> 内）：',
                '<event>',
                '<chapters>#1-#7</chapters>',
                '<time>时间阶段或场景背景</time>',
                '<title>简短精准的事件标题</title>',
                '<participants>人物A、人物B</participants>',
                '<summary>80~180字高度客观、具体、不空泛的经过、筹码变动与关键结果</summary>',
                '<info_gap>当前关键信息差（例如：谁还不知道某事；无则写无）</info_gap>',
                '</event>',
                '</chronicle>',
                '<hooks>',
                '（列出所有重要伏笔/约定/暗线，每条一行：未解决的用 `[待填] 伏笔具体内容 (#埋下章号)`，已在后续章节回收解决的用 `[已回收] 伏笔内容 (#章号)`）',
                '</hooks>',
                '<world>',
                '（列出关键物品/设备/地点/势力的最新状态，每条一行：`物品|名称：具体状态` 或 `势力|名称：具体状态`）',
                '</world>',
                '',
                '【全部批次阅读笔记】：',
                combinedNotes,
            ].join('\n'),
        }),
        () => callModel({
            stage: 'archive_synth_characters',
            systemPrompt: synthSystem,
            prompt: [
                `请基于下方全部批次阅读笔记，为《${novelData?.title || '小说'}》（截至第 ${maxAvailableChapter} 章）合稿一份极度精准的《核心人物 4 维灵魂与防 OOC 档案》。`,
                '【核心纪律】：',
                '- 严禁使用空泛的 RPG 好感标签（如 [亲密]/[厌恶]）或容易诱发霸总/里番刻板印象的夸张概括词；',
                '- 必须把“原作/游戏硬设定底骨”和“本小说当前同人演进”清晰分开又无缝融合；',
                '- 必须为每个主要人物摘录 2~3 句原著真实原话作为声线锚点，并写清其寡言/话多程度与绝对 OOC 红线！',
                existingBrief ? `\n${existingBrief}\n` : '',
                '严格按以下 XML 标签输出全部核心登场人物（主角、核心互动角色、关键配角，一般 3~8 人）：',
                '<characters>',
                '<character>',
                '<name>人物姓名</name>',
                '<role>身份定位（简短一行）</role>',
                '<canon_foundation>原作/游戏世界观硬设定底骨、专业能力、过往履历与性格底色（确保不丢原作设定）</canon_foundation>',
                '<current_situation>在本小说当前时间线（截至第' + maxAvailableChapter + '章）的真实处境、手中筹码、被掣肘之处与对各方的客观态度</current_situation>',
                '<voice_and_quotes>原著真实说话长度、寡言/碎碎念习惯、行动分寸与微表情特征；并直接摘录 2~3 句原著真实原话或内心独白</voice_and_quotes>',
                '<ooc_red_lines>绝对 OOC 红线：明确指出 AI 最容易把该角色写崩的 2~4 个误区（例如“绝不是阴鸷霸总、不邪魅一笑、不粗暴抓揉”或“绝不长篇控诉、不流露廉价羞耻崩溃”）</ooc_red_lines>',
                '</character>',
                '</characters>',
                '',
                '【全部批次阅读笔记】：',
                combinedNotes,
            ].join('\n'),
        }),
    ], concurrency);

    const parsedChronicle = parseChronicleEvents(chronicleRaw);
    const { hooks: parsedHooks, worldStates: parsedWorld } = parseArchiveHooksAndWorld(chronicleRaw, maxAvailableChapter);
    const parsedCharacters = parseCharacterProfiles(charactersRaw, maxAvailableChapter);

    completedSteps += 2;
    const synthLogEntry = {
        id: 'synth_complete',
        title: `总合稿完成 · 提炼 ${parsedChronicle.length} 条编年史事件 · ${parsedCharacters.length} 位人物灵魂档案 · ${parsedHooks.length} 条伏笔`,
        status: 'done',
        summary: `覆盖至第 ${maxAvailableChapter} 章，已清除 RP 好感标签并生成 4 维防 OOC 红线。`,
        detail: `【编年史事件】${parsedChronicle.map(e => `${e.chapterRange} ${e.title}`).join('；')}\n【核心人物】${parsedCharacters.map(c => c.name).join('、')}`,
    };
    processLog.push(synthLogEntry);
    onProgress({
        step: completedSteps,
        totalSteps,
        label: synthLogEntry.title,
        logEntry: synthLogEntry,
    });

    return {
        chronicle: parsedChronicle,
        characters: parsedCharacters,
        hooks: parsedHooks,
        worldStates: parsedWorld,
        lastArchivedChapter: maxAvailableChapter,
        archivedAt: Date.now(),
        processLog,
    };
}
