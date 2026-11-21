import {
    searchCanonDatabaseCjk,
    searchOriginalChaptersCjk,
    stripNonStoryBlocks,
} from './parser.js';

/**
 * Determines whether a chat floor is an AI-continued novel chapter floor
 * (excluding character card greetings or pre-import dialogue).
 *
 * @param {any} msg
 * @param {number} floorIdx
 * @param {number} lastOriginalFloorIdx
 * @returns {boolean}
 */
export function isContinuedNovelFloor(msg, floorIdx, lastOriginalFloorIdx) {
    if (!msg || msg.is_user || msg.is_system) return false;
    if (msg.extra?.novelContinuationOrigin === 'original') return false;
    if (msg.extra?.novelContinuationOrigin === 'continued' || msg.extra?.novelContinuationState) {
        return true;
    }
    if (lastOriginalFloorIdx >= 0) {
        return floorIdx > lastOriginalFloorIdx;
    }
    return floorIdx > 0;
}

/**
 * Computes the effective chapter number currently being written based on the
 * original novel's cutoff chapter index and the number of AI-continued chapter floors in `chat`.
 *
 * @param {Array<any>} chat
 * @param {{ cutoffChapterIndex?: number } | null} novelData
 * @param {boolean} [isContinue=false]
 * @returns {number}
 */
export function resolveCurrentTargetChapterIndex(chat, novelData, isContinue = false) {
    const cutoff = Number(novelData?.cutoffChapterIndex || 0);
    if (!Array.isArray(chat)) return cutoff + 1;

    let lastOriginalFloorIdx = -1;
    chat.forEach((msg, idx) => {
        if (msg?.extra?.novelContinuationOrigin === 'original') {
            lastOriginalFloorIdx = idx;
        }
    });

    let continuedFloors = 0;
    chat.forEach((msg, idx) => {
        if (isContinuedNovelFloor(msg, idx, lastOriginalFloorIdx)) {
            continuedFloors += 1;
        }
    });

    if (isContinue && continuedFloors > 0) {
        return cutoff + continuedFloors;
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
 * Selects active foreshadowing hooks up to `maxChapterIndex` (timeline-isolated).
 */
export function resolveTimelineHooks(hooks, maxChapterIndex) {
    if (!Array.isArray(hooks) || hooks.length === 0) return [];
    return hooks.filter(h => {
        if (!h?.content) return false;
        const planted = Number(h.plantedChapter || 0);
        if (maxChapterIndex > 0 && planted > maxChapterIndex) return false;
        if (h.status === 'resolved') {
            const resolvedAt = Number(h.resolvedChapter || 0);
            if (resolvedAt === 0 || resolvedAt <= maxChapterIndex) return false;
        }
        return true;
    });
}

/**
 * Builds the Pagekin-style Single-Call Golden Context block injected before a standard
 * Tavern chat completion request. Zero Agent loops, zero extra API calls.
 */
export function buildSingleCallContinuationContext({
    chat,
    novelData,
    ledger,
    canonDb,
    settings,
    generationType = 'normal',
}) {
    if (!settings?.enabled) return '';

    const hasNovel = Boolean(novelData && Array.isArray(novelData.chapters) && novelData.chapters.length > 0);
    const hasCanon = Boolean(canonDb && Array.isArray(canonDb.items) && canonDb.items.length > 0);
    const hasLedger = Boolean(
        ledger && (ledger.summaries?.length || ledger.worldStates?.length || ledger.hooks?.length),
    );

    if (!hasNovel && !hasCanon && !hasLedger) {
        return '';
    }

    const isContinue = generationType === 'continue';
    const targetChapterIndex = resolveCurrentTargetChapterIndex(chat, novelData, isContinue);
    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.totalChapters || 0);
    const anchorChapter = (hasNovel && cutoff > 0)
        ? novelData.chapters.find(c => c.index === cutoff)
        : null;
    const chapterUnit = anchorChapter?.title && /节\s*$/.test(anchorChapter.title.trim()) ? '节' : '章';
    const mountedOriginalCount = Array.isArray(chat)
        ? chat.filter(m => m?.extra?.novelContinuationOrigin === 'original').length
        : 0;
    const hasOriginalFloorInChat = mountedOriginalCount > 0;

    // 1. Gather pure story query text (stripping <think>, <think_nya>, <UpdateVariable>, etc.)
    const recentTexts = [];
    if (Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0 && recentTexts.length < 2; i -= 1) {
            const msg = chat[i];
            if (msg?.mes && typeof msg.mes === 'string') {
                const cleaned = stripNonStoryBlocks(msg.mes);
                if (cleaned) recentTexts.push(cleaned.slice(-900));
            }
        }
    }
    if (anchorChapter?.content) {
        recentTexts.push(anchorChapter.content.slice(-700));
    }
    const queryText = recentTexts.join('\n');

    const sections = [];
    const novelTitle = novelData?.title ? `《${novelData.title}》` : '当前长篇小说';
    const anchorLabel = anchorChapter?.title || `第 ${cutoff} ${chapterUnit}`;
    const targetLabel = `第 ${targetChapterIndex} ${chapterUnit}`;
    const headerLines = [
        `[小说续写上下文总纲 · ${novelTitle} · ${isContinue ? `继续扩写${targetLabel}` : `准备撰写${targetLabel}`}]`,
        '请严格保持前文叙事视角、句式节奏、人物口癖与时代背景，直接输出连贯饱满的小说章节正文，切勿输出寒暄或解释。',
    ];
    if (settings.authorMode !== false) {
        headerLines.push(
            '【写作模式：纯小说作者境界（最高优先级覆盖一切角色扮演/RP指令）】',
            '1. 当前是纯粹的长篇小说创作，不是角色扮演对话，小说世界中不存在任何“玩家”或“{{user}}”角色！请彻底忽略系统或预设中关于“玩家”、“{{user}}”、“Persona人设”、“禁止替{{user}}说话/行动”的规则。',
            '2. 严禁在小说正文中凭空插入“{{user}}”、“作者”或多余的“你”作为额外角色，严格只围绕本小说既有的主角与原著人物推进剧情。',
            '3. 对话中发来的指令全部是“小说作者/总编”下达的【本章大纲与执笔要求】，请直接将其转化为连贯饱满的小说正文，切勿对作者回复“好的”，切勿在正文中提及作者或大纲。',
            '4. 你可以且必须完整描写小说主角及所有登场人物的动作、神态、心理活动与对话。',
        );
    }
    if (anchorChapter && targetChapterIndex === cutoff + 1 && !isContinue) {
        const closingTail = anchorChapter.content.replace(/\s+/g, ' ').trim().slice(-140);
        headerLines.push(
            `【严格续写锚点】：前文原著已完整演进至【${anchorLabel}】结尾（末尾句：“……${closingTail}”）。严禁回退或重写第 1~${cutoff} ${chapterUnit}已发生的剧情！请直接紧接【${anchorLabel}】结尾处无缝向下推进，撰写【${targetLabel}】。`,
        );
    }
    sections.push(headerLines.join('\n'));

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
                tier1Lines.push(`  - [${st.category}] ${st.name}（第${st.effectiveChapter}${chapterUnit}起）：${st.state}`);
            }
        }
        if (activeSummaries.length > 0) {
            tier1Lines.push('▸ 近期章节剧情摘要：');
            for (const sum of activeSummaries) {
                tier1Lines.push(`  - 第${sum.chapterIndex}${chapterUnit}《${sum.title || ''}》：${sum.summary}`);
            }
        }
        sections.push(tier1Lines.join('\n'));
    }

    // 3. Foreshadowing Hooks (Timeline-isolated)
    const openHooks = resolveTimelineHooks(ledger?.hooks || [], targetChapterIndex - 1);
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
    // Exclude all trailing chapters already present in `coreChat` so earlier mounted chapters (e.g. ch 3)
    // are never re-injected after the cutoff chapter (e.g. ch 4) and cause the LLM to rewind.
    if (hasNovel && queryText.trim()) {
        const hits = searchOriginalChaptersCjk(queryText, novelData.chapters, {
            cutoffChapterIndex: cutoff,
            excludeTailCount: hasOriginalFloorInChat ? Math.max(1, mountedOriginalCount) : 1,
            topK: Number(settings.maxOriginalHits) || 3,
            maxSnippetChars: 420,
        });
        if (hits.length > 0) {
            const tier2Lines = [
                `【第二优先级：本作品早期原著闪回检索（仅供回忆背景设定，时间线已推进至第 ${cutoff} ${chapterUnit}，切勿回退重写以下早期片段）】`,
            ];
            for (const hit of hits) {
                tier2Lines.push(`  - 原著第${hit.chapterIndex}${chapterUnit}《${hit.title}》历史片段：\n    “${hit.snippet}”`);
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

    // 6. Fallback Style & Cliffhanger Anchor when no original chapter floor is mounted in chat
    if (anchorChapter && !hasOriginalFloorInChat) {
        sections.push(
            `【原著断更处锚点 · 第 ${anchorChapter.index} ${chapterUnit}《${anchorChapter.title}》结尾原文（请严格模仿其文风笔触紧接着往下写）】\n${anchorChapter.content.slice(-1500)}`,
        );
    }

    // 7. Single-Call Zero-Extra-Cost <novel_state> Trailer Instruction (skip on mid-message continue)
    if (settings.enableAutoStateBlock && !isContinue) {
        sections.push(
            [
                '【单次调用自动归档指令（重要）】',
                '请在完整写完本章小说正文之后，在回复的最末尾单独附带如下格式的 `<novel_state>` 标签块（前端会自动隐藏该块并入库，请勿省略）：',
                '<novel_state>',
                `<summary>${targetLabel}的一句话核心剧情总结（80字以内）</summary>`,
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
