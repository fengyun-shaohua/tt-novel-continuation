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
const UNCLOSED_NOVEL_STATE_REGEX = /(?:```(?:xml|html|txt)?\s*\n?)?<novel_state>([\s\S]+?)(?=<\/(?:game|story_reply|soliumbra_reply)>|$)/i;
const ESCAPED_NOVEL_STATE_REGEX = /(?:```(?:xml|html|txt)?\s*\n?)?&lt;novel_state&gt;([\s\S]*?)&lt;\/novel_state&gt;(?:\s*\n?```)?/gi;
const NOISE_BLOCKS_REGEX = /<(?:think(?:ing|_[a-z0-9]+)?~?|report_[a-z0-9]+~?|cot|details|UpdateVariable|options|novel_state)\b[^>]*>[\s\S]*?<\/(?:think(?:ing|_[a-z0-9]+)?~?|report_[a-z0-9]+~?|cot|details|UpdateVariable|options|novel_state)>/gi;
const OUTER_WRAPPER_TAGS_REGEX = /<\/?(?:story_reply|soliumbra_reply)\b[^>]*>/gi;

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
 * Strips thinking/CoT blocks (`<think>`, `<think_nya>`, `<report_nya>`, `<cot>`, `<details>`),
 * MVU variable blocks, `<novel_state>` blocks, and outer reply wrapper tags (`<story_reply>`, `<soliumbra_reply>`)
 * from message text so retrieval, TOC, and quality checks only use pure story text.
 * @param {string} text
 * @returns {string}
 */
export function stripNonStoryBlocks(text) {
    return String(text ?? '')
        .replace(NOISE_BLOCKS_REGEX, '')
        .replace(OUTER_WRAPPER_TAGS_REGEX, '')
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

const LORE_NOISE_TITLE_REGEX = /\[(?:mvu_update|mvu_status|mvu_plot)\]|角色扮演(?:注意事项|逻辑核心)|行动选项|变量(?:输出格式|更新规则|格式强调|格式防呆|禁词表|列表)|user锚定|非游玩时请关闭|必读勿删|标题\s*Z\s*到\s*A|^(?:[\p{Emoji}\uFE0F\u200D\s]*)(?:.*(?:前标|后标))$/iu;
const LORE_XML_WRAPPER_REGEX = /<\/?(?:REGION|CHARACTER|Character|CONCEPT|FACTION|LORE|SECRET|COMPANION|ITEM|LOCATION|NPC|WORLD|PLACE|EVENT|ORG)_[A-Za-z0-9_.-]+>/g;
const LORE_EJS_TAG_REGEX = /<%[\s\S]*?%>/g;
const LORE_SECTION_HEADING_REGEX = /^(?:(#{2,4})\s+(.+)|([\u4e00-\u9fa5A-Za-z0-9]{2,10})[:：]\s*)$/;
const LORE_CORE_SECTION_REGEX = /^(?:基本信息|基础信息|档案|外貌|外观|外貌特征|外貌与服装|服装|着装|穿着|配饰|武器|装备|特点|性格|性格特点|性格特征|人设|源石技艺|能力|共鸣能力|技能|战斗风格|喜欢|喜好|讨厌|厌恶|语言示例|语音|口癖|台词|说话风格|秘密|定位|概述|简介|世界观|核心设定)$/;
const LORE_DETAIL_SECTION_REGEX = /^(?:经历|过往|背景|背景故事|生平|历史|剧情表现|剧情|主线剧情|人际关系|关系|相关人物|关联角色|备注|补充|细节|其他|轶事|彩蛋)$/;
const LORE_WORLD_CORE_PRIMARY_REGEX = /(?:世界观|总纲|基础设定|泰拉$|索拉里斯)/;
const LORE_WORLD_CORE_SECONDARY_REGEX = /(?:专属名词|专有名词|货币体系|战力分级|地理|载具|个体武器)/;

function cleanLoreTitle(rawTitle) {
    let s = String(rawTitle || '').trim();
    for (let i = 0; i < 3; i += 1) {
        const next = s
            .replace(/^\[[^\]]{1,12}\][:：\s]*/, '')
            .replace(/^\d+[_.\-、\s]+/, '')
            .replace(/^[\p{Emoji}\uFE0F\u200D\s]+/u, '')
            .replace(/^[_.\-、\s]+/, '')
            .trim();
        if (next === s) break;
        s = next;
    }
    return s;
}

function inferLoreCategory(entry, rawTitle) {
    const explicit = String(entry?.category || entry?.group || '').trim();
    if (explicit) return explicit;
    const bracketMatch = String(rawTitle || '').match(/^\[([^\]\n]{1,12})\]/);
    if (bracketMatch) return bracketMatch[1].trim();
    const t = String(rawTitle || '');
    if (/🗺️|📍|区域|地区|地理|城|岛/.test(t)) return '地区';
    if (/🍔|美食|食品|特产|小吃|甜点|主菜/.test(t)) return '风物饮食';
    if (/势力|阵营|组织|学院|教团|公司|联盟/.test(t)) return '势力';
    if (/角色|人物|干员|共鸣者/.test(t)) return '角色';
    return '原作设定';
}

/**
 * Cleans EJS/MVU template tags, outer semantic XML wrappers, and excessive blank lines
 * from a World Info / supplementary lore entry while keeping all readable lore prose intact.
 *
 * @param {string} rawContent
 * @returns {{ content: string, hadEjs: boolean }}
 */
export function sanitizeLoreEntryContent(rawContent) {
    const raw = String(rawContent ?? '');
    const hadEjs = /<%[\s\S]*?%>/.test(raw);
    const cleaned = raw
        .replace(LORE_EJS_TAG_REGEX, '')
        .replace(LORE_XML_WRAPPER_REGEX, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { content: cleaned, hadEjs };
}

/**
 * Extracts plain keywords AND ReDoS-safe lookahead AND-groups (`allOfGroups`) from
 * SillyTavern World Info keys (supporting `/^(?=.*(?:A|B))(?=.*(?:C|D)).*$/s` and `/A|B/i`).
 *
 * @param {string[]} rawKeys
 * @param {string} rawTitle
 * @returns {{ keywords: string[], allOfGroups: string[][] }}
 */
export function extractLoreTriggers(rawKeys, rawTitle = '') {
    const keywordSet = new Set();
    const allOfGroups = [];

    for (const raw of rawKeys || []) {
        const key = String(raw ?? '').trim();
        if (!key || /^\$\$_NO_TRIGGER_\$\$$/i.test(key)) continue;

        const regexMatch = key.match(/^\/(.+)\/([gimsuyd]*)$/);
        if (regexMatch) {
            const body = regexMatch[1];
            const lookaheads = [...body.matchAll(/\(\?=\.\*\(\?:([^)]+)\)\)/g)];
            if (lookaheads.length >= 2) {
                const groups = lookaheads
                    .map(m => m[1].split('|').map(s => s.replace(/\\(.)/g, '$1').trim()).filter(s => s.length >= 1))
                    .filter(g => g.length > 0);
                if (groups.length >= 2) {
                    allOfGroups.push(groups);
                    continue;
                }
            }
            // Fallback for simple alternation regex like `/白金|欣特莱雅|小天马/i`
            const stripped = body
                .replace(/^\^|\$$/g, '')
                .replace(/^\(\?:|\)$/g, '');
            if (!/[?*+[\]{}()\\]/.test(stripped)) {
                for (const alt of stripped.split('|')) {
                    const term = alt.trim();
                    if (term.length >= 2) keywordSet.add(term);
                }
            }
            continue;
        }

        if (key.length >= 2) {
            keywordSet.add(key);
        } else if (/^[\u4e00-\u9fa5]$/.test(key)) {
            keywordSet.add(key);
        }
    }

    const cleanTitle = cleanLoreTitle(rawTitle);
    if (cleanTitle.length >= 2 && cleanTitle.length <= 24) {
        keywordSet.add(cleanTitle);
    }

    return {
        keywords: [...keywordSet],
        allOfGroups,
    };
}

function isLoreNoiseEntry(entry, rawTitle, rawKeys, cleanContent) {
    if (LORE_NOISE_TITLE_REGEX.test(rawTitle)) return true;
    if (rawKeys.some(k => /^\$\$_NO_TRIGGER_\$\$$/i.test(String(k || '').trim())) && !entry?.constant) {
        return true;
    }
    if (/<UpdateVariable>|mvu_VariableUpdate|mvu_json_patch/i.test(cleanContent)) {
        return true;
    }
    const compact = cleanContent.replace(/\s+/g, '');
    if (compact.length < 15) return true;
    return false;
}

function splitChunkByLength(text, maxChars = 1350) {
    const trimmed = String(text || '').trim();
    if (!trimmed || trimmed.length <= maxChars) return trimmed ? [trimmed] : [];
    const lines = trimmed.split('\n');
    const chunks = [];
    let buf = '';
    for (const line of lines) {
        if (buf.length + line.length + 1 > maxChars && buf.length >= 420) {
            chunks.push(buf.trim());
            buf = line;
        } else {
            buf = buf ? `${buf}\n${line}` : line;
        }
    }
    if (buf.trim()) {
        if (chunks.length > 0 && buf.trim().length < 220) {
            chunks[chunks.length - 1] += `\n${buf.trim()}`;
        } else {
            chunks.push(buf.trim());
        }
    }
    return chunks;
}

/**
 * Splits oversized character/world lore entries by semantic section headings so
 * Core Identity (外貌/服装/性格/能力/语言示例) stays intact (~1,700 chars) while long
 * History/Experience/Relations sections become separate searchable detail chunks.
 */
function splitLongLoreEntry(baseItem, { coreMaxChars = 1700, detailMaxChars = 1300 } = {}) {
    const content = String(baseItem.content || '').trim();
    if (content.length <= coreMaxChars) {
        return [{ ...baseItem, baseTitle: baseItem.title, chunkKind: 'core' }];
    }

    const lines = content.split('\n');
    const sections = [];
    let currentHeading = '';
    let currentLines = [];

    for (const line of lines) {
        const trimmed = line.trim();
        const m = trimmed.match(LORE_SECTION_HEADING_REGEX);
        if (m) {
            if (currentLines.length > 0) {
                sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() });
            }
            currentHeading = (m[2] || m[3] || '').trim();
            currentLines = [line];
        } else {
            currentLines.push(line);
        }
    }
    if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() });
    }

    // If no clear headings were detected, fall back to clean paragraph chunks
    if (sections.length <= 1) {
        const parts = splitChunkByLength(content, detailMaxChars);
        return parts.map((part, i) => ({
            ...baseItem,
            id: i === 0 ? baseItem.id : `${baseItem.id}_p${i + 1}`,
            title: i === 0 ? baseItem.title : `${baseItem.title}（续 ${i + 1}）`,
            baseTitle: baseItem.title,
            chunkKind: i === 0 ? 'core' : 'detail',
            content: part,
        }));
    }

    const coreParts = [];
    const detailSections = [];
    let coreLen = 0;

    for (const sec of sections) {
        if (!sec.text) continue;
        const h = sec.heading;
        const isExplicitDetail = Boolean(h && LORE_DETAIL_SECTION_REGEX.test(h));
        const isExplicitCore = !h || LORE_CORE_SECTION_REGEX.test(h);

        if (!isExplicitDetail && (isExplicitCore || coreLen < 900) && (coreLen + sec.text.length <= coreMaxChars + 250 || coreParts.length === 0)) {
            coreParts.push(sec.text);
            coreLen += sec.text.length + 2;
        } else {
            detailSections.push(sec);
        }
    }

    const out = [];
    const coreText = coreParts.join('\n\n').trim();
    if (coreText) {
        const coreChunks = coreText.length > coreMaxChars + 400
            ? splitChunkByLength(coreText, coreMaxChars)
            : [coreText];
        coreChunks.forEach((chunk, i) => {
            out.push({
                ...baseItem,
                id: i === 0 ? baseItem.id : `${baseItem.id}_c${i + 1}`,
                title: i === 0 ? baseItem.title : `${baseItem.title}（核心设定 ${i + 1}）`,
                baseTitle: baseItem.title,
                chunkKind: i === 0 ? 'core' : 'detail',
                content: chunk,
            });
        });
    }

    if (detailSections.length > 0) {
        let detailBuf = '';
        let detailHeadings = [];
        let detailIdx = 0;
        const flushDetail = () => {
            const text = detailBuf.trim();
            if (!text) return;
            detailIdx += 1;
            const suffix = detailHeadings.length > 0
                ? detailHeadings.slice(0, 2).join('/')
                : `背景细节 ${detailIdx}`;
            const headerPrefix = `# ${cleanLoreTitle(baseItem.title)}（${suffix}）\n`;
            out.push({
                ...baseItem,
                id: `${baseItem.id}_d${detailIdx}`,
                title: `${baseItem.title} · ${suffix}`,
                baseTitle: baseItem.title,
                chunkKind: 'detail',
                content: text.startsWith('#') ? text : `${headerPrefix}${text}`,
            });
            detailBuf = '';
            detailHeadings = [];
        };

        for (const sec of detailSections) {
            if (sec.text.length > detailMaxChars) {
                flushDetail();
                const pieces = splitChunkByLength(sec.text, detailMaxChars);
                pieces.forEach((piece, pIdx) => {
                    detailIdx += 1;
                    const suffix = sec.heading
                        ? (pieces.length > 1 ? `${sec.heading} ${pIdx + 1}/${pieces.length}` : sec.heading)
                        : `背景细节 ${detailIdx}`;
                    out.push({
                        ...baseItem,
                        id: `${baseItem.id}_d${detailIdx}`,
                        title: `${baseItem.title} · ${suffix}`,
                        baseTitle: baseItem.title,
                        chunkKind: 'detail',
                        content: `# ${cleanLoreTitle(baseItem.title)}（${suffix}）\n${piece}`,
                    });
                });
                continue;
            }
            if (detailBuf.length + sec.text.length + 2 > detailMaxChars && detailBuf.length >= 300) {
                flushDetail();
            }
            detailBuf = detailBuf ? `${detailBuf}\n\n${sec.text}` : sec.text;
            if (sec.heading && !detailHeadings.includes(sec.heading)) {
                detailHeadings.push(sec.heading);
            }
        }
        flushDetail();
    }

    return out.length > 0 ? out : [{ ...baseItem, baseTitle: baseItem.title, chunkKind: 'core' }];
}

function buildCompactWorldCoreDigest(constantItems, maxChars = 1800) {
    if (!Array.isArray(constantItems) || constantItems.length === 0) return '';
    const ranked = [...constantItems]
        .filter(it => it && it.chunkKind === 'core' && it.content)
        .sort((a, b) => {
            const score = (x) => {
                const ct = cleanLoreTitle(x.title);
                let s = 0;
                if (LORE_WORLD_CORE_PRIMARY_REGEX.test(ct)) s += 40;
                else if (LORE_WORLD_CORE_SECONDARY_REGEX.test(ct)) s += 15;
                return s - Math.min(8, x.content.length / 1000);
            };
            return score(b) - score(a);
        });
    const parts = [];
    let used = 0;
    for (const it of ranked) {
        if (used >= maxChars) break;
        const remain = maxChars - used;
        if (remain < 140) break;
        const snippet = it.content.length > Math.min(900, remain)
            ? `${it.content.slice(0, Math.min(900, remain))}……`
            : it.content;
        const block = `【${cleanLoreTitle(it.title) || it.title}】\n${snippet}`;
        parts.push(block);
        used += block.length + 2;
    }
    return parts.join('\n\n').trim();
}

/**
 * Parses and sanitizes a World Info JSON, JSON array, JSONL, or Markdown/TXT lore database
 * with detailed diagnostics (disabled filtering, MVU/RP noise removal, EJS stripping,
 * safe regex-group extraction, and section-aware long-entry splitting).
 *
 * @param {string} rawText
 * @param {string} [fileName='补充设定库']
 * @param {{ skipDisabled?: boolean, skipRpNoise?: boolean, splitLongEntries?: boolean }} [options]
 * @returns {{ items: Array<any>, worldCoreDigest: string, stats: { rawCount: number, keptEntries: number, itemCount: number, worldCoreCount: number, skippedDisabled: number, skippedNoise: number, sanitizedEjsCount: number, splitLongCount: number, regexKeyCount: number, totalChars: number } }}
 */
export function parseSupplementaryDatabaseDetailed(rawText, fileName = '补充设定库', options = {}) {
    const skipDisabled = options.skipDisabled !== false;
    const skipRpNoise = options.skipRpNoise !== false;
    const splitLongEntries = options.splitLongEntries !== false;

    const stats = {
        rawCount: 0,
        keptEntries: 0,
        itemCount: 0,
        worldCoreCount: 0,
        skippedDisabled: 0,
        skippedNoise: 0,
        sanitizedEjsCount: 0,
        splitLongCount: 0,
        regexKeyCount: 0,
        totalChars: 0,
    };

    const text = normalizeNovelText(rawText);
    if (!text) return { items: [], worldCoreDigest: '', stats };
    const sourceName = String(fileName || '补充设定库').replace(/\.(json|jsonl|md|txt)$/i, '');

    const finalize = (items) => {
        const constantItems = items.filter(it => it.isConstant && it.chunkKind === 'core');
        stats.itemCount = items.length;
        stats.worldCoreCount = constantItems.length;
        stats.totalChars = items.reduce((sum, it) => sum + String(it.content || '').length, 0);
        const worldCoreDigest = buildCompactWorldCoreDigest(constantItems, 1800);
        return { items, worldCoreDigest, stats };
    };

    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            const rawEntries = Array.isArray(parsed)
                ? parsed
                : (parsed?.entries && typeof parsed.entries === 'object'
                    ? Object.values(parsed.entries)
                    : []);

            if (rawEntries.length > 0) {
                stats.rawCount = rawEntries.length;
                const items = [];
                rawEntries.forEach((entry, idx) => {
                    if (!entry || typeof entry !== 'object') return;
                    if (skipDisabled && (entry.disable === true || entry.enabled === false)) {
                        stats.skippedDisabled += 1;
                        return;
                    }

                    const rawKeys = Array.isArray(entry.key)
                        ? entry.key
                        : (Array.isArray(entry.keywords)
                            ? entry.keywords
                            : String(entry.key || entry.keywords || '').split(/[,，、;；]/));
                    const rawSecKeys = Array.isArray(entry.keysecondary)
                        ? entry.keysecondary
                        : [];
                    const rawTitle = String(entry.comment || entry.title || entry.name || rawKeys[0] || `词条 ${idx + 1}`).trim();
                    const rawContent = String(entry.content || entry.description || entry.text || '');

                    const { content, hadEjs } = sanitizeLoreEntryContent(rawContent);
                    if (hadEjs) stats.sanitizedEjsCount += 1;

                    if (!content) {
                        stats.skippedNoise += 1;
                        return;
                    }
                    if (skipRpNoise && isLoreNoiseEntry(entry, rawTitle, rawKeys, content)) {
                        stats.skippedNoise += 1;
                        return;
                    }

                    const { keywords, allOfGroups } = extractLoreTriggers(rawKeys, rawTitle);
                    const secondaryKeywords = rawSecKeys
                        .map(k => String(k || '').trim())
                        .filter(k => k.length >= 2 && !/^\/.*\/[gimsuyd]*$/.test(k));
                    if (allOfGroups.length > 0 || rawKeys.some(k => /^\/.+\/[gimsuyd]*$/.test(String(k || '').trim()))) {
                        stats.regexKeyCount += 1;
                    }
                    if (keywords.length === 0 && rawTitle) {
                        keywords.push(cleanLoreTitle(rawTitle) || rawTitle);
                    }

                    const baseItem = {
                        id: `${sourceName}_${idx + 1}`,
                        title: rawTitle,
                        baseTitle: rawTitle,
                        category: inferLoreCategory(entry, rawTitle),
                        keywords,
                        ...(secondaryKeywords.length > 0 ? { secondaryKeywords } : {}),
                        ...(allOfGroups.length > 0 ? { allOfGroups } : {}),
                        isConstant: Boolean(entry.constant),
                        content,
                        source: sourceName,
                    };
                    stats.keptEntries += 1;

                    if (splitLongEntries && content.length > 1700) {
                        const chunks = splitLongLoreEntry(baseItem);
                        if (chunks.length > 1) stats.splitLongCount += 1;
                        items.push(...chunks);
                    } else {
                        items.push({ ...baseItem, chunkKind: 'core' });
                    }
                });
                return finalize(items);
            }
        } catch {
            // Fall through
        }
    }

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every(l => l.startsWith('{') && l.endsWith('}'))) {
        try {
            const items = [];
            stats.rawCount = lines.length;
            lines.forEach((line, idx) => {
                const entry = JSON.parse(line);
                if (skipDisabled && (entry.disable === true || entry.enabled === false)) {
                    stats.skippedDisabled += 1;
                    return;
                }
                const rawTitle = String(entry.title || entry.name || entry.comment || `词条 ${idx + 1}`).trim();
                const { content, hadEjs } = sanitizeLoreEntryContent(entry.content || entry.description || entry.text || '');
                if (hadEjs) stats.sanitizedEjsCount += 1;
                if (!content) return;
                const rawKeys = Array.isArray(entry.keywords)
                    ? entry.keywords
                    : [rawTitle, ...String(entry.keywords || '').split(/[,，、;；]/)];
                const { keywords, allOfGroups } = extractLoreTriggers(rawKeys, rawTitle);
                const baseItem = {
                    id: `${sourceName}_${idx + 1}`,
                    title: rawTitle,
                    baseTitle: rawTitle,
                    category: inferLoreCategory(entry, rawTitle),
                    keywords: keywords.length > 0 ? keywords : [rawTitle],
                    ...(allOfGroups.length > 0 ? { allOfGroups } : {}),
                    isConstant: Boolean(entry.constant),
                    content,
                    source: sourceName,
                };
                stats.keptEntries += 1;
                if (splitLongEntries && content.length > 1700) {
                    const chunks = splitLongLoreEntry(baseItem);
                    if (chunks.length > 1) stats.splitLongCount += 1;
                    items.push(...chunks);
                } else {
                    items.push({ ...baseItem, chunkKind: 'core' });
                }
            });
            if (items.length > 0) return finalize(items);
        } catch {
            // Fall through
        }
    }

    const sections = text.split(/\n(?=##?\s+|【[^】\n]{1,40}】)/);
    const items = [];
    stats.rawCount = sections.length;
    sections.forEach((sec, idx) => {
        const trimmed = sec.trim();
        if (!trimmed) return;
        const firstLineEnd = trimmed.indexOf('\n');
        let title = `${sourceName} #${idx + 1}`;
        let body = trimmed;

        if (firstLineEnd !== -1) {
            const firstLine = trimmed.slice(0, firstLineEnd).trim();
            if (/^(?:##?\s+|【[^】]+】)/.test(firstLine)) {
                title = firstLine.replace(/^#+\s*/, '').replace(/^【|】$/g, '').trim();
                body = trimmed.slice(firstLineEnd + 1).trim();
            }
        }
        const { content, hadEjs } = sanitizeLoreEntryContent(body);
        if (hadEjs) stats.sanitizedEjsCount += 1;
        if (!content) return;

        const keywords = title
            .split(/[｜|/\-—:：()（）,，、\s]+/)
            .map(s => s.trim())
            .filter(s => s.length >= 2);

        const baseItem = {
            id: `${sourceName}_${idx + 1}`,
            title,
            baseTitle: title,
            category: '原作设定',
            keywords: keywords.length > 0 ? keywords : [title],
            isConstant: false,
            content,
            source: sourceName,
        };
        stats.keptEntries += 1;
        if (splitLongEntries && content.length > 1700) {
            const chunks = splitLongLoreEntry(baseItem);
            if (chunks.length > 1) stats.splitLongCount += 1;
            items.push(...chunks);
        } else {
            items.push({ ...baseItem, chunkKind: 'core' });
        }
    });

    return finalize(items);
}

/**
 * Parses a supplementary fanfic / canon reference database from World Info JSON,
 * JSON array, JSONL, or Markdown/TXT sections.
 *
 * @param {string} rawText
 * @param {string} [fileName='补充设定库']
 * @param {{ skipDisabled?: boolean, skipRpNoise?: boolean, splitLongEntries?: boolean }} [options]
 * @returns {Array<{ id: string, title: string, category: string, keywords: string[], content: string, source: string }>}
 */
export function parseSupplementaryDatabase(rawText, fileName = '补充设定库', options = {}) {
    return parseSupplementaryDatabaseDetailed(rawText, fileName, options).items;
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
            if (unclosedMatch && /<(?:chapter_summary|summary|worldbook|hooks)\b/i.test(unclosedMatch[1])) {
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
            recastCursor: null,
        };
    }

    let summary = '';
    let refCursor = null;
    let recastCursor = null;
    const worldUpdateMap = new Map();
    const appearanceUpdateMap = new Map();
    const hookMap = new Map();

    const recordWorldUpdate = (entry) => {
        if (!entry?.name || !entry?.state) return;
        const key = `${entry.category || '状态'}|${entry.name}`;
        worldUpdateMap.set(key, entry);
    };
    const recordAppearanceUpdate = (entry) => {
        if (!entry?.name || !entry?.appearance) return;
        appearanceUpdateMap.set(entry.name, entry);
    };
    const recordHook = (entry) => {
        if (!entry?.content) return;
        const key = `${entry.action}|${entry.content.replace(/\s+/g, '').toLowerCase()}`;
        if (!hookMap.has(key)) hookMap.set(key, entry);
    };

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

        const recastCursorMatch = inner.match(/<recast_cursor>([\s\S]*?)(?:<\/recast_cursor>|$)/i);
        if (recastCursorMatch && recastCursorMatch[1]) {
            const numMatch = recastCursorMatch[1].match(/\d+/);
            if (numMatch) {
                const n = Number(numMatch[0]);
                if (Number.isFinite(n) && n >= 1) recastCursor = Math.floor(n);
            }
        }

        const worldMatch = inner.match(/<worldbook>([\s\S]*?)(?:<\/worldbook>|<appearance>|<hooks>|$)/i);
        if (worldMatch && worldMatch[1].trim()) {
            const rawLines = worldMatch[1].split('\n').map(stripListPrefix).filter(Boolean);
            // Split semicolon-packed multi-entries like `人物|甲：…；人物|乙：…` into separate rows
            const lines = rawLines.flatMap(l => l
                .split(/[；;]\s*(?=[^：:；;\n|｜]{1,12}[|｜][^：:；;\n|｜]{1,28}[：:])/)
                .map(stripListPrefix)
                .filter(Boolean));
            for (const line of lines) {
                if (isEmptyPlaceholder(line)) continue;
                const parsed = parseWorldUpdateLine(line);
                if (parsed && !isEmptyPlaceholder(parsed.state)) {
                    if (/^(?:外观|着装|衣着|服装|穿搭|外貌|装扮)$/.test(parsed.category)) {
                        recordAppearanceUpdate({ name: parsed.name, appearance: parsed.state });
                    }
                    recordWorldUpdate(parsed);
                }
            }
        }

        const appearMatch = inner.match(/<appearance>([\s\S]*?)(?:<\/appearance>|<hooks>|$)/i);
        if (appearMatch && appearMatch[1].trim()) {
            const rawLines = appearMatch[1].split('\n').map(stripListPrefix).filter(Boolean);
            const lines = rawLines.flatMap(l => l
                .split(/[；;]\s*(?=[^：:；;\n|｜]{1,12}[|｜][^：:；;\n|｜]{1,28}[：:])/)
                .map(stripListPrefix)
                .filter(Boolean));
            for (const line of lines) {
                if (isEmptyPlaceholder(line)) continue;
                const parsed = parseWorldUpdateLine(line);
                if (parsed && !isEmptyPlaceholder(parsed.state)) {
                    recordAppearanceUpdate({ name: parsed.name, appearance: parsed.state });
                    recordWorldUpdate({ category: '外观', name: parsed.name, state: parsed.state });
                }
            }
        }

        const hooksMatch = inner.match(/<hooks>([\s\S]*?)(?:<\/hooks>|$)/i);
        if (hooksMatch && hooksMatch[1].trim()) {
            const rawLines = hooksMatch[1].split('\n').map(stripListPrefix).filter(Boolean);
            // Split semicolon-packed hooks like `[新伏笔] A；[已填坑] B` so resolved hooks aren't merged into open ones
            const lines = rawLines.flatMap(l => l
                .split(/[；;]\s*(?=[\[【](?:已填坑|已回收|回收伏笔|回收|新伏笔|新增伏笔|新增|新线索|待填|伏笔|resolved|open|add)[\]】])/i)
                .map(stripListPrefix)
                .filter(Boolean));
            for (const line of lines) {
                if (isEmptyPlaceholder(line)) continue;
                if (/^[\[【]?(?:已填坑|已回收|回收伏笔|回收|完成|解决|resolved)[\]】]?/i.test(line)) {
                    const content = line
                        .replace(/^[\[【]?(?:已填坑|已回收|回收伏笔|回收|完成|解决|resolved)[\]】]?[:：\s\-—]*/i, '')
                        .trim();
                    if (!isEmptyPlaceholder(content)) recordHook({ action: 'resolve', content });
                } else {
                    const content = line
                        .replace(/^[\[【]?(?:新伏笔|新增伏笔|新增|新线索|埋下|待填|伏笔|open|add)[\]】]?[:：\s\-—]*/i, '')
                        .trim();
                    if (!isEmptyPlaceholder(content)) recordHook({ action: 'add', content });
                }
            }
        }
    }

    return {
        hasState: true,
        cleanText,
        summary,
        worldUpdates: [...worldUpdateMap.values()],
        appearanceUpdates: [...appearanceUpdateMap.values()],
        hooks: [...hookMap.values()],
        refCursor,
        recastCursor,
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
 * Direct exact/alias lookup for a character or entity inside sanitized lore items,
 * prioritizing `core` profile chunks (外貌/服装/性格/能力/语言示例) over `detail` history chunks.
 *
 * @param {string} name
 * @param {Array<any>} items
 * @param {{ maxChars?: number }} [options]
 * @returns {{ item: any, summary: string } | null}
 */
export function lookupLoreEntriesByName(name, items, { maxChars = 1600 } = {}) {
    const query = String(name || '').trim();
    if (!query || !Array.isArray(items) || items.length === 0) return null;
    const lowerQ = query.toLowerCase();

    let best = null;
    let bestScore = 0;

    for (const item of items) {
        if (!item?.content) continue;
        let score = 0;
        const cleanTitle = cleanLoreTitle(item.baseTitle || item.title || '').toLowerCase();
        const kws = Array.isArray(item.keywords) ? item.keywords : [];

        if (cleanTitle === lowerQ) score += 120;
        else if (cleanTitle && (cleanTitle.includes(lowerQ) || lowerQ.includes(cleanTitle))) score += 45;

        for (const kw of kws) {
            const lk = String(kw || '').trim().toLowerCase();
            if (!lk) continue;
            if (lk === lowerQ) score += 100;
            else if (lk.length >= 2 && (lk.includes(lowerQ) || lowerQ.includes(lk))) score += 25;
        }

        if (score <= 0) continue;
        if (item.chunkKind === 'core' || !item.chunkKind) score += 40;
        if (item.category === '角色') score += 10;

        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    }

    if (!best) return null;
    const content = String(best.content || '').trim();
    return {
        item: best,
        summary: content.length > maxChars ? `${content.slice(0, maxChars)}……` : content,
    };
}

/**
 * Local zero-API CJK + safe-regex-group search over the unified lore database (`globalLorePacks + canonDb`).
 * Preserves full character core profiles (up to `maxItemChars`, default 1400) and avoids
 * single mega-character history chunks monopolizing all retrieval slots.
 */
export function searchCanonDatabaseCjk(queryText, items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const topK = Number(options.topK ?? 4);
    const maxItemChars = Number(options.maxItemChars ?? 1400);
    const pinnedNames = Array.isArray(options.pinnedNames)
        ? options.pinnedNames.map(s => String(s || '').trim().toLowerCase()).filter(Boolean)
        : [];
    const rawQuery = stripNonStoryBlocks(queryText);
    const lowerQuery = rawQuery.toLowerCase();
    const { exactTerms, bigrams } = extractCjkQueryTokens(rawQuery);

    const scored = [];
    for (const item of items) {
        if (!item?.content) continue;
        let score = 0;
        let directHit = false;
        const cleanTitle = cleanLoreTitle(item.baseTitle || item.title || '');
        const lowerTitle = cleanTitle.toLowerCase();

        for (const pin of pinnedNames) {
            const matchesPin = lowerTitle === pin
                || (item.keywords || []).some(kw => String(kw || '').trim().toLowerCase() === pin);
            if (matchesPin) {
                score += item.chunkKind === 'detail' ? 35 : 140;
                directHit = true;
            }
        }

        for (const kw of item.keywords || []) {
            const k = String(kw || '').trim();
            if (!k) continue;
            if (k.length >= 2 && (rawQuery.includes(k) || lowerQuery.includes(k.toLowerCase()))) {
                score += k.length * 9;
                directHit = true;
            }
        }

        if (Array.isArray(item.allOfGroups) && item.allOfGroups.length > 0) {
            for (const groups of item.allOfGroups) {
                if (Array.isArray(groups) && groups.length >= 2 && groups.every(g => g.some(t => rawQuery.includes(t)))) {
                    score += 26;
                    directHit = true;
                }
            }
        }

        if (Array.isArray(item.secondaryKeywords) && directHit) {
            for (const sk of item.secondaryKeywords) {
                if (sk && rawQuery.includes(sk)) score += 6;
            }
        }

        if (cleanTitle.length >= 2 && rawQuery.includes(cleanTitle)) {
            score += cleanTitle.length * 7;
            directHit = true;
        } else if (item.title && rawQuery.includes(item.title)) {
            score += item.title.length * 5;
            directHit = true;
        }

        if (directHit) {
            // Prioritize Core Profile (外貌/服装/性格/语言示例) ahead of secondary History chunks
            score += item.chunkKind === 'detail' ? 0 : 18;
        }

        for (const term of exactTerms) {
            if (item.title && item.title.includes(term)) score += 6;
            if (item.content.includes(term)) score += 3;
        }
        for (const bg of bigrams) {
            if (item.title && item.title.includes(bg)) score += 2;
            else if (item.content.includes(bg)) score += 0.35;
        }

        if (score >= 6) {
            scored.push({
                title: item.title,
                baseTitle: item.baseTitle || item.title,
                chunkKind: item.chunkKind || 'core',
                category: item.category || '原作设定',
                source: item.source || '',
                content: item.content.length > maxItemChars
                    ? `${item.content.slice(0, maxItemChars)}……`
                    : item.content,
                score,
            });
        }
    }

    scored.sort((a, b) => b.score - a.score);

    // Diversity guard: at most 2 chunks (1 core + 1 detail) per baseTitle so one long character
    // never crowds out other active characters/locations in the same scene.
    const picked = [];
    const countByBase = new Map();
    for (const candidate of scored) {
        if (picked.length >= topK) break;
        const baseKey = candidate.baseTitle || candidate.title;
        const used = countByBase.get(baseKey) || 0;
        if (used >= 2) continue;
        countByBase.set(baseKey, used + 1);
        picked.push(candidate);
    }

    return picked;
}
