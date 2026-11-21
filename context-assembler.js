import { searchCanonDatabaseCjk, searchOriginalChaptersCjk } from './parser.js';

/**
 * Computes the effective chapter number currently being written based on the
 * original novel's cutoff chapter index and the number of AI-continued chapter floors in `chat`.
 *
 * @param {Array<any>} chat
 * @param {{ cutoffChapterIndex?: number } | null} novelData
 * @returns {number}
 */
export function resolveCurrentTargetChapterIndex(chat, novelData) {
    const cutoff = Number(novelData?.cutoffChapterIndex || 0);
    if (!Array.isArray(chat)) return cutoff + 1;

    let continuedFloors = 0;
    for (const msg of chat) {
        if (!msg || msg.is_user || msg.is_system) continue;
        if (msg.extra?.novelContinuationOrigin === 'original') continue;
        continuedFloors += 1;
    }
    return cutoff + continuedFloors + 1;
}

/**
 * Selects the effective state for each character/entity up to `maxChapterIndex`
 * (Pagekin-style timeline isolation: rolling back to an earlier chapter never leaks future state).
 *
 * @param {Array<{ category: string, name: string, state: string, effectiveChapter: number }>} worldStates
 * @param {number} maxChapterIndex
 * @returns {Array<{ category: string, name: string, state: string, effectiveChapter: number }>}
 */
export function resolveTimelineWorldStates(worldStates, maxChapterIndex) {
    if (!Array.isArray(worldStates) || worldStates.length === 0) return [];
    const latestByName = new Map();

    for (const entry of worldStates) {
        if (!entry?.name || !entry?.state) continue;
        const ch = Number(entry.effectiveChapter || 0);
        if (maxChapterIndex > 0 && ch > maxChapterIndex) continue;
        const key = `${entry.category || '人物'}|${entry.name}`;
        const prev = latestByName.get(key);
        if (!prev || ch >= Number(prev.effectiveChapter || 0)) {
            latestByName.set(key, entry);
        }
    }

    return [...latestByName.values()];
}

/**
 * Builds the Pagekin-style Single-Call Golden Context block injected before a standard
 * Tavern chat completion request. Zero Agent loops, zero extra API calls.
 *
 * @param {{
 *   chat: Array<any>,
 *   novelData: { title: string, totalChapters: number, cutoffChapterIndex: number, chapters: Array<{ index: number, title: string, content: string }> } | null,
 *   ledger: { summaries: Array<any>, worldStates: Array<any>, hooks: Array<any> },
 *   canonDb: { items: Array<any> },
 *   settings: {
 *     enabled: boolean,
 *     enableAutoStateBlock: boolean,
 *     maxOriginalHits: number,
 *     maxCanonHits: number,
 *     maxRecentSummaries: number
 *   }
 * }} params
 * @returns {string}
 */
export function buildSingleCallContinuationContext({ chat, novelData, ledger, canonDb, settings }) {
    if (!settings?.enabled) return '';

    const hasNovel = Boolean(novelData && Array.isArray(novelData.chapters) && novelData.chapters.length > 0);
    const hasCanon = Boolean(canonDb && Array.isArray(canonDb.items) && canonDb.items.length > 0);
    const hasLedger = Boolean(
        ledger && (ledger.summaries?.length || ledger.worldStates?.length || ledger.hooks?.length),
    );

    if (!hasNovel && !hasCanon && !hasLedger) {
        return '';
    }

    const targetChapterIndex = resolveCurrentTargetChapterIndex(chat, novelData);
    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.totalChapters || 0);

    // 1. Gather query text from the latest user instruction + tail of the latest story floor
    const recentTexts = [];
    if (Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0 && recentTexts.length < 2; i -= 1) {
            const msg = chat[i];
            if (msg?.mes && typeof msg.mes === 'string') {
                recentTexts.push(msg.mes.slice(-900));
            }
        }
    }
    if (hasNovel && cutoff > 0) {
        const anchorChapter = novelData.chapters.find(c => c.index === cutoff);
        if (anchorChapter?.content) {
            recentTexts.push(anchorChapter.content.slice(-700));
        }
    }
    const queryText = recentTexts.join('\n');

    const sections = [];
    const novelTitle = novelData?.title ? `《${novelData.title}》` : '当前长篇小说';
    sections.push(
        `[小说续写上下文总纲 · ${novelTitle} · 准备撰写第 ${targetChapterIndex} 章]`,
        '请严格保持前文叙事视角、句式节奏、人物口癖与时代背景，直接输出连贯饱满的小说章节正文，切勿输出寒暄或解释。',
    );

    // 2. Tier 1: Active Timeline World States & Recent Summaries (Highest Priority)
    const activeStates = resolveTimelineWorldStates(ledger?.worldStates || [], targetChapterIndex - 1);
    const activeSummaries = (ledger?.summaries || [])
        .filter(s => Number(s.chapterIndex || 0) < targetChapterIndex)
        .sort((a, b) => a.chapterIndex - b.chapterIndex)
        .slice(-(Number(settings.maxRecentSummaries) || 6));

    if (activeStates.length > 0 || activeSummaries.length > 0) {
        const tier1Lines = ['【第一优先级：当前时间线已确认状态与前情提要（最高事实权威）】'];
        if (activeStates.length > 0) {
            tier1Lines.push('▸ 当前人物/势力/物品最新状态：');
            for (const st of activeStates.slice(-18)) {
                tier1Lines.push(`  - [${st.category}] ${st.name}（第${st.effectiveChapter}章起）：${st.state}`);
            }
        }
        if (activeSummaries.length > 0) {
            tier1Lines.push('▸ 近期章节剧情摘要：');
            for (const sum of activeSummaries) {
                tier1Lines.push(`  - 第${sum.chapterIndex}章《${sum.title || ''}》：${sum.summary}`);
            }
        }
        sections.push(tier1Lines.join('\n'));
    }

    // 3. Foreshadowing Hooks (Pinned for this chapter vs Open background threads)
    const openHooks = (ledger?.hooks || []).filter(h => h.status !== 'resolved');
    if (openHooks.length > 0) {
        const pinned = openHooks.filter(h => h.status === 'pinned');
        const unpinned = openHooks.filter(h => h.status !== 'pinned').slice(-6);
        const hookLines = ['【伏笔与长线线索调度】'];
        if (pinned.length > 0) {
            hookLines.push('▸ 🎯 本章必须推进或回收的重点伏笔（请自然融入本章剧情）：');
            for (const h of pinned) {
                hookLines.push(`  - [本章重点] ${h.content}`);
            }
        }
        if (unpinned.length > 0) {
            hookLines.push('▸ 🔮 尚未揭晓的长期暗线（保持悬念，未到时机勿强行揭开）：');
            for (const h of unpinned) {
                hookLines.push(`  - [暗线] ${h.content}`);
            }
        }
        sections.push(hookLines.join('\n'));
    }

    // 4. Tier 2: Local CJK Flashback Retrieval from Imported Original Novel (<= cutoffChapterIndex)
    if (hasNovel && queryText.trim()) {
        const hits = searchOriginalChaptersCjk(queryText, novelData.chapters, {
            cutoffChapterIndex: cutoff,
            excludeTailCount: 1,
            topK: Number(settings.maxOriginalHits) || 3,
            maxSnippetChars: 420,
        });
        if (hits.length > 0) {
            const tier2Lines = [
                `【第二优先级：本作品前文原著闪回检索（时间线截止至第 ${cutoff} 章，后续章节已屏蔽防剧透）】`,
            ];
            for (const hit of hits) {
                tier2Lines.push(`  - 原著第${hit.chapterIndex}章《${hit.title}》原文片段：\n    “${hit.snippet}”`);
            }
            sections.push(tier2Lines.join('\n'));
        }
    }

    // 5. Tier 3: Supplementary Fanfic Canon Database with Butterfly-Effect Protection
    if (hasCanon && queryText.trim()) {
        const canonHits = searchCanonDatabaseCjk(queryText, canonDb.items, {
            topK: Number(settings.maxCanonHits) || 4,
            maxItemChars: 450,
        });
        if (canonHits.length > 0) {
            const tier3Lines = [
                '【第三优先级：同人补充原作设定数据库（注意蝴蝶效应保护：若以下原作设定与【第一/第二优先级】中本作品已改写的同人剧情冲突，严格以本作品已发生的事实为准！）】',
            ];
            for (const item of canonHits) {
                tier3Lines.push(`  - [${item.category}] ${item.title}：${item.content}`);
            }
            sections.push(tier3Lines.join('\n'));
        }
    }

    // 6. Fallback Style & Cliffhanger Anchor if original chapter isn't mounted in chat
    if (hasNovel && cutoff > 0) {
        const hasOriginalFloorInChat = Array.isArray(chat) && chat.some(m => !m?.is_user && m?.mes?.length > 200);
        if (!hasOriginalFloorInChat) {
            const lastOriginal = novelData.chapters.find(c => c.index === cutoff);
            if (lastOriginal) {
                sections.push(
                    `【原著断更处锚点 · 第 ${lastOriginal.index} 章《${lastOriginal.title}》结尾原文（请严格模仿其文风笔触紧接着往下写）】\n${lastOriginal.content.slice(-1500)}`,
                );
            }
        }
    }

    // 7. Single-Call Zero-Extra-Cost <novel_state> Trailer Instruction
    if (settings.enableAutoStateBlock) {
        sections.push(
            [
                '【单次调用自动归档指令（重要）】',
                '请在完整写完本章小说正文之后，在回复的最末尾单独附带如下格式的 `<novel_state>` 标签块（前端会自动隐藏该块并入库，请勿省略）：',
                '<novel_state>',
                `<summary>第${targetChapterIndex}章的一句话核心剧情总结（80字以内）</summary>`,
                '<worldbook>',
                '- 人物|角色名：本章结束时的最新状态/修为/持有物/关系变化（仅写本章有变动的条目）',
                '</worldbook>',
                '<hooks>',
                '- [新伏笔] 本章新埋下的悬念（若无则不写）',
                '- [已填坑] 本章已揭晓或完成的伏笔（若无则不写）',
                '</hooks>',
                '</novel_state>',
            ].join('\n'),
        );
    }

    return sections.join('\n\n');
}
