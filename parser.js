/**
 * Pure parsing, CJK full-text retrieval, and <novel_state> extraction utilities
 * for the Novel Continuation extension. Zero DOM or network dependencies.
 */

const CHAPTER_HEADING_REGEX = /^[\t \u3000]*(?:(?:正文|第[零一二三四五六七八九十百千万两〇○\d]+[卷集部篇])[\t \u3000]*)?(?:第[\t \u3000]*[零一二三四五六七八九十百千万两〇○壹贰叁肆伍陆柒捌玖拾佰仟\d]+[\t \u3000]*[章节回幕折]|(?:Chapter|CHAPTER)\s+\d+|【第[零一二三四五六七八九十百千万两〇○\d]+[章节回]】)[^\n\r]{0,80}$/gm;

const FALLBACK_CHUNK_SIZE = 4200;
const NOVEL_STATE_BLOCK_REGEX = /<novel_state>([\s\S]*?)<\/novel_state>/gi;

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
 * Splits an imported novel (.txt / .md) into structured chapters.
 * Falls back to sentence-aligned chunking when no explicit chapter headings exist.
 *
 * @param {string} rawText
 * @param {string} [fileName='未命名小说.txt']
 * @returns {{ title: string, totalChapters: number, cutoffChapterIndex: number, chapters: Array<{ index: number, title: string, content: string, wordCount: number }> }}
 */
export function parseNovelTxt(rawText, fileName = '未命名小说.txt') {
    const text = normalizeNovelText(rawText);
    const cleanTitle = String(fileName || '未命名小说')
        .replace(/\.(txt|md|epub|json)$/i, '')
        .replace(/^《|》$/g, '')
        .trim() || '未命名小说';

    if (!text) {
        return { title: cleanTitle, totalChapters: 0, cutoffChapterIndex: 0, chapters: [] };
    }

    const matches = [];
    CHAPTER_HEADING_REGEX.lastIndex = 0;
    let match;
    while ((match = CHAPTER_HEADING_REGEX.exec(text)) !== null) {
        const heading = match[0].trim().replace(/[\t \u3000]+/g, ' ');
        matches.push({ heading, start: match.index, bodyStart: match.index + match[0].length });
    }

    const rawChapters = [];

    if (matches.length >= 2) {
        const prologue = text.slice(0, matches[0].start).trim();
        if (prologue.length >= 200) {
            rawChapters.push({ title: '序章 / 前言', content: prologue });
        }
        for (let i = 0; i < matches.length; i += 1) {
            const current = matches[i];
            const nextStart = i + 1 < matches.length ? matches[i + 1].start : text.length;
            const body = text.slice(current.bodyStart, nextStart).trim();
            if (!body && i + 1 < matches.length) {
                continue;
            }
            rawChapters.push({
                title: current.heading,
                content: body,
            });
        }
    } else {
        // Fallback: split by ~4200 characters at paragraph boundaries
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

    const chapters = rawChapters.map((item, idx) => {
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

    // 1. Try JSON (SillyTavern World Info `{ entries: {...} }` or array)
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
            // Fall through to JSONL or Markdown/TXT parser
        }
    }

    // 2. Try JSONL
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
            // Fall through to Markdown/TXT heading parser
        }
    }

    // 3. Markdown / TXT section parser (`# 标题`, `## 词条`, or `【词条】`)
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

/**
 * Extracts and strips the trailing `<novel_state>...</novel_state>` XML block
 * generated during single-call continuation.
 *
 * @param {string} rawMessageText
 * @returns {{
 *   hasState: boolean,
 *   cleanText: string,
 *   summary: string,
 *   worldUpdates: Array<{ category: string, name: string, state: string }>,
 *   hooks: Array<{ action: 'add' | 'resolve', content: string }>
 * }}
 */
export function extractNovelStateBlock(rawMessageText) {
    const raw = String(rawMessageText ?? '');
    NOVEL_STATE_BLOCK_REGEX.lastIndex = 0;
    const matches = [...raw.matchAll(NOVEL_STATE_BLOCK_REGEX)];
    if (matches.length === 0) {
        return {
            hasState: false,
            cleanText: raw,
            summary: '',
            worldUpdates: [],
            hooks: [],
        };
    }

    let summary = '';
    const worldUpdates = [];
    const hooks = [];

    for (const match of matches) {
        const inner = match[1] || '';

        const summaryMatch = inner.match(/<summary>([\s\S]*?)<\/summary>/i);
        if (summaryMatch && summaryMatch[1].trim()) {
            summary = summaryMatch[1].trim();
        }

        const worldMatch = inner.match(/<worldbook>([\s\S]*?)<\/worldbook>/i);
        if (worldMatch && worldMatch[1].trim()) {
            const lines = worldMatch[1].split('\n').map(l => l.replace(/^[\s\-*•]+/, '').trim()).filter(Boolean);
            for (const line of lines) {
                const parsed = parseWorldUpdateLine(line);
                if (parsed) worldUpdates.push(parsed);
            }
        }

        const hooksMatch = inner.match(/<hooks>([\s\S]*?)<\/hooks>/i);
        if (hooksMatch && hooksMatch[1].trim()) {
            const lines = hooksMatch[1].split('\n').map(l => l.replace(/^[\s\-*•]+/, '').trim()).filter(Boolean);
            for (const line of lines) {
                if (/^\[?(?:已填坑|已回收|完成|resolved)\]?/i.test(line)) {
                    const content = line.replace(/^\[?(?:已填坑|已回收|完成|resolved)\]?[:：\s]*/i, '').trim();
                    if (content) hooks.push({ action: 'resolve', content });
                } else {
                    const content = line.replace(/^\[?(?:新伏笔|新增伏笔|待填|伏笔|open|add)\]?[:：\s]*/i, '').trim();
                    if (content) hooks.push({ action: 'add', content });
                }
            }
        }
    }

    const cleanText = raw.replace(NOVEL_STATE_BLOCK_REGEX, '').trimEnd();

    return {
        hasState: true,
        cleanText,
        summary,
        worldUpdates,
        hooks,
    };
}

function parseWorldUpdateLine(line) {
    // Supports: `类别|名称：状态描述` or `名称：状态描述`
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
 * @param {string} queryText
 * @returns {{ exactTerms: string[], bigrams: string[] }}
 */
export function extractCjkQueryTokens(queryText) {
    const cleaned = String(queryText ?? '')
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ')
        .trim();
    if (!cleaned) return { exactTerms: [], bigrams: [] };

    const segments = cleaned.split(/\s+/).filter(Boolean);
    const exactSet = new Set();
    const bigramSet = new Set();

    // Extract bracketed or quoted entity names from raw query first
    const quotedMatches = String(queryText ?? '').match(/(?:【([^】]{2,16})】|「([^」]{2,16})」|“([^”]{2,16})”|"([^"]{2,16})")/g) || [];
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
 * Local zero-API CJK search over novel chapters with Pagekin-style timeline cutoff protection.
 * Automatically filters out any chapter with `index > cutoffChapterIndex` to prevent future spoilers.
 *
 * @param {string} queryText
 * @param {Array<{ index: number, title: string, content: string }>} chapters
 * @param {{ cutoffChapterIndex?: number, excludeTailCount?: number, topK?: number, maxSnippetChars?: number }} [options]
 * @returns {Array<{ chapterIndex: number, title: string, snippet: string, score: number }>}
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

    const { exactTerms, bigrams } = extractCjkQueryTokens(queryText);
    if (exactTerms.length === 0 && bigrams.length === 0) return [];

    const results = [];

    for (const chapter of chapters) {
        if (chapter.index > maxAllowedChapter) continue;
        const paragraphs = chapter.content.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 25);

        let bestPara = '';
        let bestScore = 0;

        for (const para of paragraphs) {
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

        if (bestScore >= 4 && bestPara) {
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
 *
 * @param {string} queryText
 * @param {Array<{ id: string, title: string, category: string, keywords: string[], content: string }>} items
 * @param {{ topK?: number, maxItemChars?: number }} [options]
 * @returns {Array<{ title: string, category: string, content: string, score: number }>}
 */
export function searchCanonDatabaseCjk(queryText, items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const topK = Number(options.topK ?? 4);
    const maxItemChars = Number(options.maxItemChars ?? 450);
    const rawQuery = String(queryText ?? '');
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
