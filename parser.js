/**
 * Pure parsing, CJK full-text retrieval, and <novel_state> extraction utilities
 * for the Novel Continuation extension. Zero DOM or network dependencies.
 */

const VOLUME_LINE_REGEX = /^[\t \u3000]*(?:#{1,6}[\t \u3000]+)?第[\t \u3000]*[零一二三四五六七八九十百千万两〇○壹贰叁肆伍陆柒捌玖拾佰仟\d]+[\t \u3000]*[篇卷部集](?:[\t \u3000：:、\-—（(].{0,50})?$/;
const CHAPTER_LINE_REGEX = /^[\t \u3000]*(?:#{1,6}[\t \u3000]+)?(?:(?:正文|第[零一二三四五六七八九十百千万两〇○\d]+[卷集部篇])[\t \u3000]*)?(?:第[\t \u3000]*[零一二三四五六七八九十百千万两〇○壹贰叁肆伍陆柒捌玖拾佰仟\d]+[\t \u3000]*[章节回幕折]|(?:Chapter|CHAPTER)\s+\d+|【第[零一二三四五六七八九十百千万两〇○\d]+[章节回]】|(?:引子|序章|楔子|尾声|终章|番外(?:[\t \u3000：:·\-\d一二三四五六七八九十].{0,30})?))(?:[\t \u3000：:、\-—].{0,60}|[\t \u3000]*[^\n\r]{0,50})?$/;

const FALLBACK_CHUNK_SIZE = 4200;
const MEGA_CHAPTER_THRESHOLD = 8000;
const MEGA_CHAPTER_TARGET = 4500;
const NOVEL_STATE_BLOCK_REGEX = /(?:```(?:xml|html|txt)?\s*\n?)?<novel_state>([\s\S]*?)<\/novel_state>(?:\s*\n?```)?/gi;
const UNCLOSED_NOVEL_STATE_REGEX = /(?:```(?:xml|html|txt)?\s*\n?)?<novel_state>([\s\S]+?)(?=<\/game>|$)/i;
const ESCAPED_NOVEL_STATE_REGEX = /(?:```(?:xml|html|txt)?\s*\n?)?&lt;novel_state&gt;([\s\S]*?)&lt;\/novel_state&gt;(?:\s*\n?```)?/gi;
const NOISE_BLOCKS_REGEX = /<(?:think(?:ing|_[a-z0-9]+)?|cot|details|UpdateVariable|options|novel_state)\b[^>]*>[\s\S]*?<\/(?:think(?:ing|_[a-z0-9]+)?|cot|details|UpdateVariable|options|novel_state)>/gi;

const CJK_STOPWORDS = new Set([
    '一个', '一下', '一些', '一切', '一样', '一直', '一定', '已经', '以及', '以后',
    '以为', '之后', '之前', '之间', '之中', '之所以', '什么', '他们', '她们', '它们',
    '你们', '我们', '自己', '这个', '这里', '这样', '这么', '那个', '那里', '那样',
    '那么', '怎么', '因为', '所以', '但是', '不过', '而且', '或者', '如果', '虽然',
    '可以', '可能', '应该', '没有', '不是', '就是', '还是', '只是', '开始', '继续',
    '下一章', '本章', '章节', '续写', '主角', '小说', '剧情', '方向', '要求', '描写',
]);

/**
 * Normalizes line breaks and strips UTF-8 BOM.
 * @param {string} rawText
 * @returns {string}
 */
export function normalizeNovelText(rawText) {
    return String(rawText ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trim();
}

/**
 * Strips thinking/CoT blocks (`<think>`, `<think_nya>`, `<cot>`, `<details>`), MVU variable blocks,
 * and `<novel_state>` blocks from message text so retrieval queries only use pure story text.
 * @param {string} text
 * @returns {string}
 */
export function stripNonStoryBlocks(text) {
    return String(text ?? '')
        .replace(NOISE_BLOCKS_REGEX, '')
        .trim();
}

/**
 * Splits an oversized chapter (> MEGA_CHAPTER_THRESHOLD chars) into paragraph-aligned sub-parts
 * so mobile rendering, scrolling, and cutoff selection stay smooth and precise.
 *
 * @param {string} title
 * @param {string} content
 * @returns {Array<{ title: string, content: string }>}
 */
function splitMegaChapterIfNeeded(title, content) {
    const compactLen = content.replace(/\s+/g, '').length;
    if (compactLen <= MEGA_CHAPTER_THRESHOLD) {
        return [{ title, content }];
    }

    const paragraphs = content.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let buffer = '';
    for (const para of paragraphs) {
        if (buffer.length + para.length > MEGA_CHAPTER_TARGET && buffer.length >= 1200) {
            chunks.push(buffer.trim());
            buffer = para;
        } else {
            buffer = buffer ? `${buffer}\n\n${para}` : para;
        }
    }
    if (buffer.trim()) {
        if (chunks.length > 0 && buffer.trim().length < 700) {
            chunks[chunks.length - 1] += `\n\n${buffer.trim()}`;
        } else {
            chunks.push(buffer.trim());
        }
    }

    if (chunks.length <= 1) {
        return [{ title, content }];
    }
    return chunks.map((chunk, idx) => ({
        title: `${title} (${idx + 1}/${chunks.length})`,
        content: chunk,
    }));
}

/**
 * Classifies a single line as a volume heading, chapter heading, or normal prose.
 * Rejects lines ending in sentence/dialogue punctuation to avoid false positives inside prose.
 */
function classifyHeadingLine(rawLine) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.length > 60) return null;
    if (/[，,。；;”"」]$/.test(trimmed)) return null;

    const clean = trimmed
        .replace(/^#{1,6}[\t \u3000]+/, '')
        .replace(/[\t \u3000]+/g, ' ')
        .trim();

    if (CHAPTER_LINE_REGEX.test(trimmed)) {
        return { kind: 'chapter', heading: clean };
    }
    if (VOLUME_LINE_REGEX.test(trimmed)) {
        return { kind: 'volume', heading: clean };
    }
    return null;
}

/**
 * Splits an imported novel (.txt / .md) into structured chapters.
 * Supports multi-volume/part prefixes (`第一篇：侵蚀` -> `第一篇：侵蚀 · 第1章`),
 * Markdown headings (`# 第一章`), auto sub-splitting of mega-chapters (>8000 chars),
 * and paragraph-aligned fallback chunking.
 *
 * @param {string} rawText
 * @param {string} [fileName='未命名小说.txt']
 * @returns {{ title: string, totalChapters: number, cutoffChapterIndex: number, chapters: Array<{ index: number, title: string, content: string, wordCount: number }> }}
 */
export function parseNovelTxt(rawText, fileName = '未命名小说.txt') {
    let text = normalizeNovelText(rawText);
    const cleanTitle = String(fileName || '未命名小说')
        .replace(/\.(txt|md|epub|json)$/i, '')
        .replace(/^《|》$/g, '')
        .trim() || '未命名小说';

    if (!text) {
        return { title: cleanTitle, totalChapters: 0, cutoffChapterIndex: 0, chapters: [] };
    }

    // Strip common TXT site boilerplate banners at file start/end
    text = text
        .replace(/^-{5,}\n[^\n]{0,120}(?:本文件来自|发布页|下载自)[\s\S]{0,200}?-{5,}\s*/i, '')
        .replace(/\s*-{5,}\n[^\n]{0,120}(?:本文件来自|发布页|下载自)[\s\S]{0,200}?-{5,}$/i, '')
        .trim();

    const lines = text.split('\n');
    const matches = [];
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
        const cls = classifyHeadingLine(lines[lineIdx]);
        if (cls) {
            matches.push({ ...cls, lineIdx });
        }
    }

    const rawChapters = [];

    if (matches.length >= 2) {
        const prologue = lines.slice(0, matches[0].lineIdx).join('\n').trim();
        if (prologue.replace(/\s+/g, '').length >= 200) {
            rawChapters.push({ title: '序章 / 前言', content: prologue });
        }

        let currentVolume = '';
        for (let i = 0; i < matches.length; i += 1) {
            const current = matches[i];
            const nextLineIdx = i + 1 < matches.length ? matches[i + 1].lineIdx : lines.length;
            const body = lines.slice(current.lineIdx + 1, nextLineIdx).join('\n').trim();
            const bodyLen = body.replace(/\s+/g, '').length;

            if (current.kind === 'volume') {
                if (bodyLen < 150 && i + 1 < matches.length) {
                    // Pure volume/part divider (e.g. `第一篇：侵蚀` right before `第1章`)
                    currentVolume = current.heading;
                    continue;
                }
                // Standalone volume/part containing its own story text (e.g. `第零篇 贪鼬（序）：渗透`)
                currentVolume = '';
                rawChapters.push({
                    title: current.heading,
                    content: body,
                });
                continue;
            }

            if (bodyLen === 0 && i + 1 < matches.length) {
                continue;
            }

            const isStandaloneSpecial = /^(?:引子|序章|楔子|尾声|终章|番外)/.test(current.heading);
            const fullTitle = (currentVolume && !isStandaloneSpecial && !current.heading.includes(currentVolume))
                ? `${currentVolume} · ${current.heading}`
                : current.heading;

            rawChapters.push({
                title: fullTitle,
                content: body,
            });
        }
    } else {
        const paragraphs = text.split(/\n{2,}|\n(?=[　\t ]{2,})/);
        let buffer = '';
        let autoIndex = 1;
        for (const para of paragraphs) {
            const trimmed = para.trim();
            if (!trimmed) continue;
            if (buffer.length + trimmed.length > FALLBACK_CHUNK_SIZE && buffer.length >= 800) {
                rawChapters.push({
                    title: `第 ${autoIndex} 节`,
                    content: buffer.trim(),
                });
                autoIndex += 1;
                buffer = trimmed;
            } else {
                buffer = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
            }
        }
        if (buffer.trim()) {
            rawChapters.push({
                title: `第 ${autoIndex} 节`,
                content: buffer.trim(),
            });
        }
    }

    const normalizedChapters = [];
    for (const item of rawChapters) {
        const parts = splitMegaChapterIfNeeded(item.title, item.content.trim());
        normalizedChapters.push(...parts);
    }

    const chapters = normalizedChapters.map((item, idx) => {
        const index = idx + 1;
        const content = item.content.trim();
        return {
            index,
            title: item.title || `第 ${index} 章`,
            content,
            wordCount: content.replace(/\s+/g, '').length,
        };
    });

    return {
        title: cleanTitle,
        totalChapters: chapters.length,
        cutoffChapterIndex: chapters.length,
        chapters,
    };
}

/**
 * Parses a supplementary fanfic / canon reference database from World Info JSON,
 * JSON array, JSONL, or Markdown/TXT sections.
 *
 * @param {string} rawText
 * @param {string} [fileName='补充设定库']
 * @returns {Array<{ id: string, title: string, category: string, keywords: string[], content: string, source: string }>}
 */
export function parseSupplementaryDatabase(rawText, fileName = '补充设定库') {
    const text = normalizeNovelText(rawText);
    if (!text) return [];
    const sourceName = String(fileName || '补充设定库').replace(/\.(json|jsonl|md|txt)$/i, '');

    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            const rawEntries = Array.isArray(parsed)
                ? parsed
                : (parsed?.entries && typeof parsed.entries === 'object'
                    ? Object.values(parsed.entries)
                    : []);

            if (rawEntries.length > 0) {
                return rawEntries
                    .map((entry, idx) => {
                        const rawKeys = Array.isArray(entry.key)
                            ? entry.key
                            : (Array.isArray(entry.keywords)
                                ? entry.keywords
                                : String(entry.key || entry.keywords || '').split(/[,，、;；]/));
                        const keywords = rawKeys.map(k => String(k).trim()).filter(Boolean);
                        const title = String(entry.comment || entry.title || entry.name || keywords[0] || `词条 ${idx + 1}`).trim();
                        const content = String(entry.content || entry.description || entry.text || '').trim();
                        const category = String(entry.category || entry.group || '原作设定').trim();
                        if (!content) return null;
                        if (keywords.length === 0 && title) keywords.push(title);
                        return {
                            id: `${sourceName}_${idx + 1}`,
                            title,
                            category,
                            keywords,
                            content,
                            source: sourceName,
                        };
                    })
                    .filter(Boolean);
            }
        } catch {
            // Fall through
        }
    }

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every(l => l.startsWith('{') && l.endsWith('}'))) {
        try {
            const items = [];
            lines.forEach((line, idx) => {
                const entry = JSON.parse(line);
                const title = String(entry.title || entry.name || entry.comment || `词条 ${idx + 1}`).trim();
                const content = String(entry.content || entry.description || entry.text || '').trim();
                if (!content) return;
                const keywords = Array.isArray(entry.keywords)
                    ? entry.keywords.map(k => String(k).trim()).filter(Boolean)
                    : [title, ...String(entry.keywords || '').split(/[,，、;；]/).map(s => s.trim()).filter(Boolean)];
                items.push({
                    id: `${sourceName}_${idx + 1}`,
                    title,
                    category: String(entry.category || '原作设定').trim(),
                    keywords: [...new Set(keywords)],
                    content,
                    source: sourceName,
                });
            });
            if (items.length > 0) return items;
        } catch {
            // Fall through
        }
    }

    const sections = text.split(/\n(?=##?\s+|【[^】\n]{1,40}】)/);
    const items = [];
    sections.forEach((sec, idx) => {
        const trimmed = sec.trim();
        if (!trimmed) return;
        const firstLineEnd = trimmed.indexOf('\n');
        let title = `${sourceName} #${idx + 1}`;
        let content = trimmed;

        if (firstLineEnd !== -1) {
            const firstLine = trimmed.slice(0, firstLineEnd).trim();
            if (/^(?:##?\s+|【[^】]+】)/.test(firstLine)) {
                title = firstLine.replace(/^#+\s*/, '').replace(/^【|】$/g, '').trim();
                content = trimmed.slice(firstLineEnd + 1).trim();
            }
        }
        if (!content) return;

        const keywords = title
            .split(/[｜|/\-—:：()（）,，、\s]+/)
            .map(s => s.trim())
            .filter(s => s.length >= 2);

        items.push({
            id: `${sourceName}_${idx + 1}`,
            title,
            category: '原作设定',
            keywords: keywords.length > 0 ? keywords : [title],
            content,
            source: sourceName,
        });
    });

    return items;
}

function stripListPrefix(line) {
    return String(line ?? '')
        .replace(/^[\s\-*•]+/, '')
        .replace(/^(?:\d+[.、)）]\s*)+/, '')
        .trim();
}

function isEmptyPlaceholder(text) {
    const t = String(text ?? '').trim();
    if (!t) return true;
    return /^(?:无|暂无|无变动|无新增|无更新|无回收|没有|略|无伏笔|none|n\/a|-|—+)$/i.test(t);
}

/**
 * Extracts and strips the trailing `<novel_state>...</novel_state>` XML block.
 * Tolerates markdown code fences, HTML-escaped tags, and truncated unclosed trailing blocks.
 */
export function extractNovelStateBlock(rawMessageText) {
    const raw = String(rawMessageText ?? '');
    NOVEL_STATE_BLOCK_REGEX.lastIndex = 0;
    ESCAPED_NOVEL_STATE_REGEX.lastIndex = 0;

    let innerBlocks = [];
    let cleanText = raw;

    const standardMatches = [...raw.matchAll(NOVEL_STATE_BLOCK_REGEX)];
    if (standardMatches.length > 0) {
        innerBlocks = standardMatches.map(m => m[1] || '');
        cleanText = raw.replace(NOVEL_STATE_BLOCK_REGEX, '').trimEnd();
    } else {
        const escapedMatches = [...raw.matchAll(ESCAPED_NOVEL_STATE_REGEX)];
        if (escapedMatches.length > 0) {
            innerBlocks = escapedMatches.map(m =>
                String(m[1] || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
            );
            cleanText = raw.replace(ESCAPED_NOVEL_STATE_REGEX, '').trimEnd();
        } else {
            const unclosedMatch = raw.match(UNCLOSED_NOVEL_STATE_REGEX);
            if (unclosedMatch && /<(?:summary|worldbook|hooks)\b/i.test(unclosedMatch[1])) {
                innerBlocks = [unclosedMatch[1]];
                cleanText = raw.replace(UNCLOSED_NOVEL_STATE_REGEX, '').trimEnd();
            }
        }
    }

    if (innerBlocks.length === 0) {
        return {
            hasState: false,
            cleanText: raw,
            summary: '',
            worldUpdates: [],
            appearanceUpdates: [],
            hooks: [],
            refCursor: null,
        };
    }

    let summary = '';
    let refCursor = null;
    const worldUpdates = [];
    const appearanceUpdates = [];
    const hooks = [];

    for (const inner of innerBlocks) {
        const summaryMatch = inner.match(/<(?:chapter_summary|summary)>([\s\S]*?)(?:<\/(?:chapter_summary|summary)>|$)/i);
        if (summaryMatch && !isEmptyPlaceholder(summaryMatch[1])) {
            summary = summaryMatch[1].trim();
        }

        const refCursorMatch = inner.match(/<ref_cursor>([\s\S]*?)(?:<\/ref_cursor>|$)/i);
        if (refCursorMatch && refCursorMatch[1]) {
            const numMatch = refCursorMatch[1].match(/\d+/);
            if (numMatch) {
                const n = Number(numMatch[0]);
                if (Number.isFinite(n) && n >= 0) refCursor = Math.floor(n);
            }
        }

        const worldMatch = inner.match(/<worldbook>([\s\S]*?)(?:<\/worldbook>|<appearance>|<hooks>|$)/i);
        if (worldMatch && worldMatch[1].trim()) {
            const lines = worldMatch[1].split('\n').map(stripListPrefix).filter(Boolean);
            for (const line of lines) {
                if (isEmptyPlaceholder(line)) continue;
                const parsed = parseWorldUpdateLine(line);
                if (parsed && !isEmptyPlaceholder(parsed.state)) {
                    if (/^(?:外观|着装|衣着|服装|穿搭|外貌|装扮)$/.test(parsed.category)) {
                        appearanceUpdates.push({ name: parsed.name, appearance: parsed.state });
                    }
                    worldUpdates.push(parsed);
                }
            }
        }

        const appearMatch = inner.match(/<appearance>([\s\S]*?)(?:<\/appearance>|<hooks>|$)/i);
        if (appearMatch && appearMatch[1].trim()) {
            const lines = appearMatch[1].split('\n').map(stripListPrefix).filter(Boolean);
            for (const line of lines) {
                if (isEmptyPlaceholder(line)) continue;
                const parsed = parseWorldUpdateLine(line);
                if (parsed && !isEmptyPlaceholder(parsed.state)) {
                    appearanceUpdates.push({ name: parsed.name, appearance: parsed.state });
                    worldUpdates.push({ category: '外观', name: parsed.name, state: parsed.state });
                }
            }
        }

        const hooksMatch = inner.match(/<hooks>([\s\S]*?)(?:<\/hooks>|$)/i);
        if (hooksMatch && hooksMatch[1].trim()) {
            const lines = hooksMatch[1].split('\n').map(stripListPrefix).filter(Boolean);
            for (const line of lines) {
                if (isEmptyPlaceholder(line)) continue;
                if (/^[\[【]?(?:已填坑|已回收|回收伏笔|回收|完成|解决|resolved)[\]】]?/i.test(line)) {
                    const content = line
                        .replace(/^[\[【]?(?:已填坑|已回收|回收伏笔|回收|完成|解决|resolved)[\]】]?[:：\s\-—]*/i, '')
                        .trim();
                    if (!isEmptyPlaceholder(content)) hooks.push({ action: 'resolve', content });
                } else {
                    const content = line
                        .replace(/^[\[【]?(?:新伏笔|新增伏笔|新增|新线索|埋下|待填|伏笔|open|add)[\]】]?[:：\s\-—]*/i, '')
                        .trim();
                    if (!isEmptyPlaceholder(content)) hooks.push({ action: 'add', content });
                }
            }
        }
    }

    return {
        hasState: true,
        cleanText,
        summary,
        worldUpdates,
        appearanceUpdates,
        hooks,
        refCursor,
    };
}

function parseWorldUpdateLine(line) {
    const colonIdx = line.search(/[:：]/);
    if (colonIdx === -1) return null;
    const head = line.slice(0, colonIdx).trim();
    const state = line.slice(colonIdx + 1).trim();
    if (!head || !state) return null;

    const pipeIdx = head.search(/[|｜/]/);
    if (pipeIdx !== -1) {
        const category = head.slice(0, pipeIdx).trim() || '人物';
        const name = head.slice(pipeIdx + 1).trim();
        return name ? { category, name, state } : null;
    }
    return { category: '状态', name: head, state };
}

/**
 * Tokenizes Chinese/English query text into bigrams and entity terms for local retrieval.
 */
export function extractCjkQueryTokens(queryText) {
    const storyOnly = stripNonStoryBlocks(queryText);
    const cleaned = storyOnly
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ')
        .trim();
    if (!cleaned) return { exactTerms: [], bigrams: [] };

    const segments = cleaned.split(/\s+/).filter(Boolean);
    const exactSet = new Set();
    const bigramSet = new Set();

    const quotedMatches = storyOnly.match(/(?:【([^】]{2,16})】|「([^」]{2,16})」|“([^”]{2,16})”|"([^"]{2,16})")/g) || [];
    for (const q of quotedMatches) {
        const inner = q.slice(1, -1).trim();
        if (inner.length >= 2 && !CJK_STOPWORDS.has(inner)) {
            exactSet.add(inner);
        }
    }

    for (const seg of segments) {
        if (CJK_STOPWORDS.has(seg)) continue;
        if (/^[a-zA-Z0-9]+$/.test(seg)) {
            if (seg.length >= 2) exactSet.add(seg.toLowerCase());
            continue;
        }
        if (seg.length >= 2 && seg.length <= 8 && !CJK_STOPWORDS.has(seg)) {
            exactSet.add(seg);
        }
        for (let i = 0; i < seg.length - 1; i += 1) {
            const bg = seg.slice(i, i + 2);
            if (!CJK_STOPWORDS.has(bg)) {
                bigramSet.add(bg);
            }
        }
    }

    return {
        exactTerms: [...exactSet].slice(0, 30),
        bigrams: [...bigramSet].slice(0, 80),
    };
}

/**
 * Groups chapter lines into searchable ~180+ char windows so short dialogue lines are never dropped.
 */
function buildSearchableParagraphWindows(content) {
    const rawLines = String(content || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
    const windows = [];
    let buffer = '';
    for (const line of rawLines) {
        buffer = buffer ? `${buffer}\n${line}` : line;
        if (buffer.length >= 140) {
            windows.push(buffer);
            buffer = '';
        }
    }
    if (buffer) {
        if (windows.length > 0 && buffer.length < 40) {
            windows[windows.length - 1] += `\n${buffer}`;
        } else {
            windows.push(buffer);
        }
    }
    return windows;
}

/**
 * Parses a human chapter range spec such as `78-135, 140, 145~150` into sorted unique chapter indices.
 *
 * @param {string} rangeText
 * @param {number} [maxChapter=Infinity]
 * @returns {number[]}
 */
export function parseChapterRangeSpec(rangeText, maxChapter = Infinity) {
    const raw = String(rangeText || '').trim();
    if (!raw) return [];
    const upper = Number.isFinite(maxChapter) && maxChapter > 0 ? Math.floor(maxChapter) : Infinity;
    const set = new Set();
    const parts = raw.split(/[,，、;\s]+/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        const rangeMatch = part.match(/^#?(\d+)\s*[-~—至到]\s*#?(\d+)$/);
        if (rangeMatch) {
            let start = Number(rangeMatch[1]);
            let end = Number(rangeMatch[2]);
            if (start > end) [start, end] = [end, start];
            const clampedStart = Math.max(1, start);
            const clampedEnd = Math.min(upper, end);
            for (let i = clampedStart; i <= clampedEnd; i += 1) {
                set.add(i);
            }
            continue;
        }
        const singleMatch = part.match(/^#?(\d+)$/);
        if (singleMatch) {
            const n = Number(singleMatch[1]);
            if (n >= 1 && n <= upper) set.add(n);
        }
    }
    return [...set].sort((a, b) => a - b);
}

/**
 * Local zero-API CJK search over novel chapters with Pagekin-style timeline cutoff protection.
 */
export function searchOriginalChaptersCjk(queryText, chapters, options = {}) {
    if (!Array.isArray(chapters) || chapters.length === 0) return [];
    const cutoff = Number.isFinite(options.cutoffChapterIndex) && options.cutoffChapterIndex > 0
        ? options.cutoffChapterIndex
        : chapters.length;
    const excludeTail = Number(options.excludeTailCount ?? 1);
    const maxAllowedChapter = Math.max(0, cutoff - excludeTail);
    const topK = Number(options.topK ?? 3);
    const maxSnippetChars = Number(options.maxSnippetChars ?? 420);
    const excludedRoles = new Set(
        Array.isArray(options.excludeTimelineRoles)
            ? options.excludeTimelineRoles
            : [
                'skip',
                ...(options.excludeFlashback ? ['flashback'] : []),
                ...(options.excludeReference ? ['reference'] : []),
            ],
    );

    const { exactTerms, bigrams } = extractCjkQueryTokens(queryText);
    if (exactTerms.length === 0 && bigrams.length === 0) return [];

    const results = [];

    for (const chapter of chapters) {
        if (chapter.index > maxAllowedChapter) continue;
        if (chapter.timelineRole && excludedRoles.has(chapter.timelineRole)) continue;
        const windows = buildSearchableParagraphWindows(chapter.content);

        let bestPara = '';
        let bestScore = 0;

        for (const para of windows) {
            let score = 0;
            for (const term of exactTerms) {
                if (para.includes(term) || chapter.title.includes(term)) {
                    score += term.length * 4;
                }
            }
            for (const bg of bigrams) {
                if (para.includes(bg)) {
                    score += 1;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestPara = para;
            }
        }

        if (bestScore >= 3 && bestPara) {
            const snippet = bestPara.length > maxSnippetChars
                ? `${bestPara.slice(0, maxSnippetChars)}……`
                : bestPara;
            results.push({
                chapterIndex: chapter.index,
                title: chapter.title,
                snippet,
                score: bestScore,
            });
        }
    }

    return results
        .sort((a, b) => b.score - a.score || b.chapterIndex - a.chapterIndex)
        .slice(0, topK);
}

/**
 * Local zero-API CJK search over the supplementary fanfic/canon database (`canonDb`).
 */
export function searchCanonDatabaseCjk(queryText, items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const topK = Number(options.topK ?? 4);
    const maxItemChars = Number(options.maxItemChars ?? 450);
    const rawQuery = stripNonStoryBlocks(queryText);
    const { exactTerms, bigrams } = extractCjkQueryTokens(rawQuery);

    const scored = [];
    for (const item of items) {
        let score = 0;
        for (const kw of item.keywords || []) {
            if (kw && kw.length >= 2 && rawQuery.includes(kw)) {
                score += kw.length * 8;
            }
        }
        if (item.title && rawQuery.includes(item.title)) {
            score += item.title.length * 6;
        }
        for (const term of exactTerms) {
            if (item.title.includes(term)) score += 6;
            if (item.content.includes(term)) score += 3;
        }
        for (const bg of bigrams) {
            if (item.title.includes(bg)) score += 2;
            else if (item.content.includes(bg)) score += 0.5;
        }

        if (score >= 4) {
            scored.push({
                title: item.title,
                category: item.category || '原作设定',
                content: item.content.length > maxItemChars
                    ? `${item.content.slice(0, maxItemChars)}……`
                    : item.content,
                score,
            });
        }
    }

    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}
