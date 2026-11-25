import {
    lookupLoreEntriesByName,
    searchCanonDatabaseCjk,
    searchOriginalChaptersCjk,
    stripNonStoryBlocks,
} from './parser.js';
import { buildAntiClichePromptGuidance } from './cliche-guard.js';
import { sanitizeStyleCardText } from './style-distiller.js';

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
export function resolveActiveAnchorChapter(novelData, excludeFlashback = true) {
    if (!novelData || !Array.isArray(novelData.chapters) || novelData.chapters.length === 0) return null;
    const cutoff = Number(novelData.cutoffChapterIndex || novelData.totalChapters || novelData.chapters.length);
    const eligible = novelData.chapters
        .filter(c => {
            if (!c || Number(c.index) > cutoff) return false;
            if (c.timelineRole === 'skip' || c.timelineRole === 'reference') return false;
            if (excludeFlashback && c.timelineRole === 'flashback') return false;
            return true;
        })
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    if (eligible.length > 0) return eligible[eligible.length - 1];
    return novelData.chapters.find(c => Number(c.index) === cutoff) || novelData.chapters[novelData.chapters.length - 1];
}

export function resolveCurrentTargetChapterIndex(
    chat,
    novelData,
    isContinue = false,
    excludeFlashback = true,
    recastConfig = null,
) {
    const isRecast = Boolean(recastConfig?.enabled && Array.isArray(novelData?.chapters) && novelData.chapters.length > 0);
    if (isRecast) {
        if (!Array.isArray(chat)) return 1;
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
        if (isContinue && continuedFloors > 0) return continuedFloors;
        return continuedFloors + 1;
    }

    const activeAnchor = Array.isArray(novelData?.chapters) && novelData.chapters.length > 0
        ? resolveActiveAnchorChapter(novelData, excludeFlashback)
        : null;
    const baseChapter = Number(activeAnchor?.index || novelData?.cutoffChapterIndex || 0);
    if (!Array.isArray(chat)) return baseChapter + 1;

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
        return baseChapter + continuedFloors;
    }
    return baseChapter + continuedFloors + 1;
}

/**
 * Resolves the source original chapter referenced by Recast Mode (`sourceCursorChapter`, 1-based).
 */
export function resolveRecastSourceChapter(novelData, recastConfig, offset = 0) {
    if (!recastConfig?.enabled || !Array.isArray(novelData?.chapters) || novelData.chapters.length === 0) {
        return null;
    }
    const baseCursor = Math.max(1, Number(recastConfig.sourceCursorChapter) || 1);
    const targetIdx = baseCursor + Math.max(0, Number(offset) || 0);
    if (targetIdx > novelData.chapters.length) return null;
    return novelData.chapters.find(c => Number(c.index) === targetIdx) || novelData.chapters[targetIdx - 1] || null;
}

/**
 * Formats an original chapter cleanly for Recast Mode structural & prose reference.
 */
export function formatSourceChapterExcerpt(chapter, maxChars = 5200) {
    const clean = stripNonStoryBlocks(chapter?.content || '').trim();
    if (!clean) return '';
    if (clean.length <= maxChars) return clean;
    const headLen = Math.floor(maxChars * 0.42);
    const midLen = Math.floor(maxChars * 0.2);
    const tailLen = Math.max(400, maxChars - headLen - midLen);
    const midStart = Math.max(headLen, Math.floor((clean.length - midLen) / 2));
    return [
        clean.slice(0, headLen).trimEnd(),
        '……（原著中段骨架抽样）……',
        clean.slice(midStart, midStart + midLen).trim(),
        '……（原著后半与结尾落点）……',
        clean.slice(-tailLen).trimStart(),
    ].join('\n\n');
}

const RECAST_FIDELITY_GUIDES = Object.freeze({
    strict: '紧贴原著分镜：保留原著本章几乎全部场景顺序、切镜节奏、事件节点与段长结构，只将涉及替换角色的台词、心理、微动作、外貌着装和局部反应 100% 转化为新角色的真实人设。',
    balanced: '保主线顺因果（推荐）：保留原著本章的核心事件骨架、叙事节奏与文风质感；允许因新角色真实性格、能力与行事底线的差异，自然推导出不同的对话交锋、微动作与局部因果涟漪（严禁硬拗回原女主台词）。',
    free: '借骨架自由重塑：仅借鉴原著本章的开场情境、核心冲突引子与原作者行文质感，其余推进完全顺从新角色的性格动机与前文已产生的蝴蝶效应自由展开。',
});

/**
 * Builds the unified Chapter-by-Chapter Role-Swap / Recast prompt block shared by
 * both Single-Call Generation (`buildSingleCallContinuationContext`) and Director Outline (`buildDirectorOutlinePrompt`).
 */
export function buildRecastModePromptBlock({
    novelData = null,
    recastConfig = null,
    loreItems = [],
    includeSourceText = true,
    sourceChapterCount = 1,
    maxSourceChars = 5200,
} = {}) {
    if (!recastConfig?.enabled || !Array.isArray(novelData?.chapters) || novelData.chapters.length === 0) {
        return { text: '', pinnedBaseTitles: [], sourceChapters: [] };
    }

    const mappings = (Array.isArray(recastConfig.mappings) ? recastConfig.mappings : [])
        .filter(m => m && (m.fromName || m.toName || m.toProfile));
    const fidelityDesc = RECAST_FIDELITY_GUIDES[recastConfig.fidelity] || RECAST_FIDELITY_GUIDES.balanced;
    const count = Math.max(1, Math.min(3, Number(sourceChapterCount) || 1));
    const sourceChapters = [];
    for (let i = 0; i < count; i += 1) {
        const ch = resolveRecastSourceChapter(novelData, recastConfig, i);
        if (ch) sourceChapters.push(ch);
    }
    if (sourceChapters.length === 0) {
        return { text: '', pinnedBaseTitles: [], sourceChapters: [] };
    }

    const fromNames = mappings.map(m => m.fromName).filter(Boolean);
    const toNames = mappings.map(m => m.toName).filter(Boolean);
    const pinnedBaseTitles = [];

    const firstSrc = sourceChapters[0];
    const lastSrc = sourceChapters[sourceChapters.length - 1];
    const rangeTag = sourceChapters.length > 1
        ? `原著第 ${firstSrc.index}~${lastSrc.index} 章对照重塑`
        : `原著第 ${firstSrc.index} 章《${firstSrc.title || `第 ${firstSrc.index} 章`}》对照重塑`;

    const lines = [
        `【逐章换角仿写 / 角色重塑最高协议（${rangeTag}）】`,
        `- 改编保真策略：${fidelityDesc}`,
        '- 绝对创作红线：',
        ...(fromNames.length > 0
            ? [`  1. 【零残名铁律】：正文中严禁残留或误写被替换的原著角色名（${fromNames.join('、')}）及其专属绰号/外貌特征！`]
            : ['  1. 【零串戏铁律】：严格按照下方角色替换表执行重塑，不得混入原被替换角色的姓名与特征！']),
        `  2. 【严禁机械换皮 OOC】：绝对不要只把名字替换成「${toNames.join(' / ') || '新角色'}」却照搬原角色的性格、撒娇/暴躁模板或台词习惯！必须依据下方新角色的真实底骨（外貌、常服、性格、能力与说话语气），重新演绎每一句对话、微表情与行动选择。`,
        '  3. 【复刻原著文风与节奏】：严格学习下方原著对照范本的断句长短、叙事距离、对话密度与切镜频率，拒绝套用廉价网文腔；同时自然承接前几章已经产生的改写蝴蝶效应。',
    ];

    if (mappings.length > 0) {
        lines.push('', '▸ 角色替换映射与新角色完整底骨档案：');
        for (const m of mappings) {
            const pairLabel = m.fromName && m.toName
                ? `原著「${m.fromName}」 → 替换为「${m.toName}」`
                : (m.toName ? `核心新登场角色「${m.toName}」` : `原著「${m.fromName}」调整`);
            lines.push(`◆ ${pairLabel}`);
            if (m.toProfile) {
                lines.push(`  · 作者指定新角色要点：${m.toProfile}`);
            }
            if (m.toName && Array.isArray(loreItems) && loreItems.length > 0) {
                const hit = lookupLoreEntriesByName(m.toName, loreItems, { maxChars: 1500 });
                if (hit?.summary) {
                    pinnedBaseTitles.push(hit.item.baseTitle || hit.item.title);
                    const userAlreadyHasFull = m.toProfile && m.toProfile.length >= 200 && hit.summary.slice(0, 60) && m.toProfile.includes(hit.summary.slice(0, 60));
                    if (!userAlreadyHasFull) {
                        lines.push(`  · 纯净资料库完整原设底骨（[${hit.item.category || '角色'}] ${hit.item.title}）：\n${hit.summary}`);
                    }
                }
            }
            if (m.note) {
                lines.push(`  · 剧情与关系适配说明：${m.note}`);
            }
        }
    }

    if (recastConfig.extraRules) {
        lines.push('', `▸ 额外世界观与背景微调要求：\n${recastConfig.extraRules}`);
    }

    if (includeSourceText) {
        const perBudget = sourceChapters.length > 1
            ? Math.max(1800, Math.floor(maxSourceChars / sourceChapters.length))
            : maxSourceChars;
        for (const ch of sourceChapters) {
            const excerpt = formatSourceChapterExcerpt(ch, perBudget);
            if (!excerpt) continue;
            lines.push(
                '',
                `▸ 【原著第 ${ch.index} 章《${ch.title || `第 ${ch.index} 章`}》对照范本（供复刻文风、段长节奏与剧情骨架；请按上方替换表彻底重塑，严禁照抄被替换原名与原性格）】：`,
                excerpt,
            );
        }
    }

    return {
        text: lines.join('\n'),
        pinnedBaseTitles,
        sourceChapters,
    };
}

/**
 * Deterministically builds a compact 0-API bridge of recent chapters that are NOT yet covered
 * by `ledger.chronicle` (including unarchived original main chapters and all AI-continued chapters),
 * preferring `<novel_state>` summaries and falling back to saved author outline / head+mid+tail prose skeletons.
 * Guarantees Director Outline, Continuation, and Deep Rewrite NEVER lose context across long continued arcs.
 */
export function buildUnarchivedRecentChaptersBridge({
    novelData = null,
    continuedChapters = [],
    ledger = null,
    upToChapterIndex = Infinity,
    excludeFlashback = true,
    excludeChapterIndices = [],
    maxItems = 18,
} = {}) {
    const excludeSet = new Set((excludeChapterIndices || []).map(Number));
    const narrativeCfg = ledger?.narrativeConfig || {};
    const refMode = Boolean(narrativeCfg.referenceTimelineMode);
    const refSet = new Set(
        (novelData?.chapters || []).filter(c => c && c.timelineRole === 'reference').map(c => Number(c.index)),
    );

    const mainChronicle = (ledger?.chronicle || []).filter(e => {
        if (!e || e.timelinePhase === 'flashback') return false;
        if (e.timelinePhase === 'reference') return false;
        if (refMode && refSet.has(Number(e.startChapter))) return false;
        return true;
    });
    const maxChronicleMain = mainChronicle.reduce(
        (mx, e) => Math.max(mx, Number(e.endChapter || e.startChapter || 0)),
        0,
    );
    const archivedFloor = Math.max(Number(ledger?.lastArchivedChapter || 0), maxChronicleMain);

    const summaryByChapter = new Map();
    for (const s of (ledger?.summaries || [])) {
        if (s && Number(s.chapterIndex) > 0 && String(s.summary || '').trim()) {
            summaryByChapter.set(Number(s.chapterIndex), s);
        }
    }

    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.chapters?.length || 0);
    const byChapter = new Map();

    // 1) Unarchived original main chapters (archivedFloor + 1 .. min(cutoff, upToChapterIndex))
    for (const ch of (novelData?.chapters || [])) {
        const idx = Number(ch?.index || 0);
        if (idx <= archivedFloor || idx > cutoff || idx > upToChapterIndex || excludeSet.has(idx)) continue;
        if (ch.timelineRole === 'skip' || ch.timelineRole === 'reference') continue;
        if (excludeFlashback && ch.timelineRole === 'flashback') continue;
        byChapter.set(idx, {
            index: idx,
            title: ch.title || `第 ${idx} 章`,
            content: String(ch.content || ''),
            authorOutline: '',
            origin: 'original',
        });
    }

    // 2) ALL continued chapters up to `upToChapterIndex` (even if missing `<novel_state>` summaries!)
    for (const ch of (continuedChapters || [])) {
        const idx = Number(ch?.index || 0);
        if (idx <= 0 || idx > upToChapterIndex || excludeSet.has(idx)) continue;
        // Include if unarchived OR always include recent continued chapters so outline/continuation stay grounded
        if (idx <= archivedFloor && !summaryByChapter.has(idx)) continue;
        byChapter.set(idx, {
            index: idx,
            title: ch.title || `第 ${idx} 章`,
            content: String(ch.content || ''),
            authorOutline: String(ch.authorOutline || ''),
            origin: 'continued',
        });
    }

    // Also include any ledger.summaries entries above archivedFloor that weren't in chat/novel arrays
    for (const [idx, sum] of summaryByChapter.entries()) {
        if (idx > archivedFloor && idx <= upToChapterIndex && !excludeSet.has(idx) && !byChapter.has(idx)) {
            byChapter.set(idx, {
                index: idx,
                title: sum.title || `第 ${idx} 章`,
                content: '',
                authorOutline: '',
                origin: 'summary',
            });
        }
    }

    const sorted = [...byChapter.values()]
        .sort((a, b) => a.index - b.index)
        .slice(-Math.max(1, Number(maxItems) || 18));

    if (sorted.length === 0) {
        return { lines: [], startChapter: 0, endChapter: 0, count: 0 };
    }

    const buildProseSkeleton = (content, outline) => {
        const cleanOutline = String(outline || '')
            .replace(/【本章执笔纪律】[\s\S]*$/i, '')
            .replace(/^【第\s*\d+\s*[章节回][^】]*】\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        const cleanBody = stripNonStoryBlocks(content || '').replace(/<\/?game>/gi, '').replace(/\s+/g, ' ').trim();
        if (cleanOutline.length >= 16) {
            const tail = cleanBody ? ` ｜ 实际结尾：…${cleanBody.slice(-70)}` : '';
            return `${cleanOutline.slice(0, 200)}${cleanOutline.length > 200 ? '…' : ''}${tail}`;
        }
        if (!cleanBody) return '（无正文摘录）';
        if (cleanBody.length <= 240) return cleanBody;
        const midStart = Math.max(85, Math.floor(cleanBody.length * 0.48) - 40);
        return `开头：${cleanBody.slice(0, 85)}… ｜ 中段：…${cleanBody.slice(midStart, midStart + 80)}… ｜ 结尾：…${cleanBody.slice(-85)}`;
    };

    const lines = sorted.map(item => {
        const savedSum = summaryByChapter.get(item.index);
        const tag = item.origin === 'continued' ? '已续写' : '未归档原著';
        if (savedSum?.summary) {
            return `- [第${item.index}章·${tag}] ${item.title}：${savedSum.summary}`;
        }
        return `- [第${item.index}章·${tag}实录] ${item.title}：${buildProseSkeleton(item.content, item.authorOutline)}`;
    });

    return {
        lines,
        startChapter: sorted[0].index,
        endChapter: sorted[sorted.length - 1].index,
        count: sorted.length,
    };
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
 * Pure check for whether a ledger carries a populated L1/L2 story blueprint.
 */
export function hasStoryBlueprintData(blueprint) {
    if (!blueprint || typeof blueprint !== 'object') return false;
    return Boolean(
        String(blueprint.title || '').trim()
        || String(blueprint.premise || '').trim()
        || String(blueprint.seedNotes || '').trim()
        || String(blueprint.worldRules || '').trim()
        || (Array.isArray(blueprint.volumes) && blueprint.volumes.length > 0),
    );
}

/**
 * Resolves the currently active L2 volume from `storyBlueprint.volumes` for `targetChapterIndex`.
 * Priority: explicit `status === 'active'` -> chapter range match -> first non-completed volume -> last volume.
 */
export function resolveActiveVolume(storyBlueprint, targetChapterIndex = 1) {
    const vols = Array.isArray(storyBlueprint?.volumes) ? storyBlueprint.volumes.filter(Boolean) : [];
    if (vols.length === 0) return null;
    const explicitActive = vols.find(v => v.status === 'active');
    if (explicitActive) return explicitActive;
    const ch = Math.max(1, Number(targetChapterIndex) || 1);
    const inRange = vols.find(v => ch >= Number(v.startChapter || 1) && ch <= Number(v.endChapter || Infinity));
    if (inRange) return inRange;
    return vols.find(v => v.status !== 'completed') || vols[vols.length - 1];
}

/**
 * Formats L1 Master Blueprint + L2 Active Volume + Completed Volume Recaps + Next Volume Spoiler Guard
 * into a concise prompt block shared by both Chapter Generation and L3 Director Outline Planning.
 */
export function buildStoryBlueprintContextBlock(storyBlueprint, targetChapterIndex = 1, { includeNextVolumeGuard = true } = {}) {
    if (!hasStoryBlueprintData(storyBlueprint)) return '';
    const modeLabel = storyBlueprint.creationMode === 'original'
        ? '原创世界观长篇'
        : (storyBlueprint.creationMode === 'fanfic_new' ? '同人新开坑长篇' : '长篇连载');
    const lines = [`【L1 全书总纲与 L2 分卷路线图（${modeLabel} · 宏观主线最高蓝图）】`];
    if (storyBlueprint.genreAndTone) lines.push(`- 题材与基调：${storyBlueprint.genreAndTone}`);
    if (storyBlueprint.premise) lines.push(`- 核心主线与人物弧线：${storyBlueprint.premise}`);
    if (storyBlueprint.worldRules) lines.push(`- 世界观硬规则与红线：${storyBlueprint.worldRules}`);
    if (storyBlueprint.endingDirection) lines.push(`- 远期终局方向（供宏观防跑偏参考，严禁在早期章节提前透支或让人物一步到位提前黑化/崩坏，必须严格按当前卷阶段循序渐进）：${storyBlueprint.endingDirection}`);
    if (!storyBlueprint.premise && storyBlueprint.seedNotes) {
        lines.push(`- 作者立项设定与创意底稿：${String(storyBlueprint.seedNotes).slice(0, 1400)}`);
    }

    const vols = Array.isArray(storyBlueprint.volumes) ? storyBlueprint.volumes.filter(Boolean) : [];
    if (vols.length > 0) {
        const activeVol = resolveActiveVolume(storyBlueprint, targetChapterIndex);
        const completedWithRecap = vols.filter(v => v.status === 'completed' && v !== activeVol);
        if (completedWithRecap.length > 0) {
            lines.push('▸ 📚 已完结卷精要复盘：');
            for (const cv of completedWithRecap.slice(-4)) {
                const body = cv.recap ? cv.recap.slice(0, 260) : (cv.goal || '已完成');
                lines.push(`  - [第${cv.index}卷 ${cv.title} · ${cv.chapterRange}]：${body}`);
            }
        }
        if (activeVol) {
            lines.push(
                `▸ 🔥 当前连载卷（第 ${activeVol.index} 卷《${activeVol.title}》 · 规划范围 ${activeVol.chapterRange}，当前第 ${targetChapterIndex} 章）：`,
            );
            if (activeVol.goal) lines.push(`  · 本卷核心目标与矛盾：${activeVol.goal}`);
            if (activeVol.keyTurns) lines.push(`  · 本卷关键转折与高潮节点：${activeVol.keyTurns}`);
            if (activeVol.endingHook) lines.push(`  · 本卷收束落点与下卷钩子：${activeVol.endingHook}`);
            if (activeVol.recap) lines.push(`  · 本卷阶段复盘进度：${activeVol.recap.slice(0, 320)}`);

            if (includeNextVolumeGuard) {
                const activeIdx = vols.indexOf(activeVol);
                const nextVol = activeIdx >= 0 ? vols[activeIdx + 1] : null;
                if (nextVol) {
                    lines.push(
                        `▸ 🔒 下一卷预告边界（第 ${nextVol.index} 卷《${nextVol.title}》 · ${nextVol.chapterRange}，切勿在本卷提前透支或掀光以下大事件）：${nextVol.goal || nextVol.title}`,
                    );
                }
            }
        }
    }
    return lines.join('\n');
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
    loreBundle = null,
    settings,
    generationType = 'normal',
    hasExternalLwbSummary = false,
}) {
    if (!settings?.enabled) return '';

    const unifiedLoreItems = Array.isArray(loreBundle?.items)
        ? loreBundle.items
        : (Array.isArray(canonDb?.items) ? canonDb.items : []);
    const worldCores = Array.isArray(loreBundle?.worldCores) ? loreBundle.worldCores : [];
    const hasNovel = Boolean(novelData && Array.isArray(novelData.chapters) && novelData.chapters.length > 0);
    const hasCanon = unifiedLoreItems.length > 0 || worldCores.length > 0;
    const hasBlueprint = hasStoryBlueprintData(ledger?.storyBlueprint);
    const hasStyleProfile = Boolean(ledger?.styleProfile?.styleCard && String(ledger.styleProfile.styleCard).trim());
    const hasChronicle = Boolean(Array.isArray(ledger?.chronicle) && ledger.chronicle.length > 0);
    const hasCharacters = Boolean(Array.isArray(ledger?.characters) && ledger.characters.length > 0);
    const hasLedger = Boolean(
        ledger && (ledger.summaries?.length || hasChronicle || hasCharacters || ledger.worldStates?.length || ledger.hooks?.length || hasStyleProfile || hasBlueprint),
    );

    if (!hasNovel && !hasCanon && !hasLedger) {
        return '';
    }

    const narrativeCfg = ledger?.narrativeConfig || {};
    const recastCfg = narrativeCfg.recast || null;
    const isRecastMode = Boolean(recastCfg?.enabled && hasNovel);
    const excludeFlashback = narrativeCfg.excludeFlashbackFromAnchor !== false;
    const strictPov = narrativeCfg.povMode === 'strict_limited' && Boolean(String(narrativeCfg.povCharacter || '').trim());
    const povChar = strictPov ? String(narrativeCfg.povCharacter).trim() : '';
    const povPersonLabel = narrativeCfg.povPerson === 'first_person'
        ? '第一人称限制视角（“我”）'
        : (narrativeCfg.povPerson === 'third_limited' ? '第三人称限制视角' : '严格跟随前文人称的限制视角');

    const isContinue = generationType === 'continue';
    const targetChapterIndex = resolveCurrentTargetChapterIndex(chat, novelData, isContinue, excludeFlashback, recastCfg);
    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.totalChapters || 0);
    const anchorChapter = (!isRecastMode && hasNovel && cutoff > 0)
        ? resolveActiveAnchorChapter(novelData, excludeFlashback)
        : null;
    const recastSourceChapter = isRecastMode ? resolveRecastSourceChapter(novelData, recastCfg, 0) : null;
    const activeAnchorIndex = Number(anchorChapter?.index || cutoff);
    const sampleTitleForUnit = recastSourceChapter?.title || anchorChapter?.title || novelData?.chapters?.[0]?.title || '';
    const chapterUnit = sampleTitleForUnit && /节\s*$/.test(sampleTitleForUnit.trim()) ? '节' : '章';
    const mountedOriginalCount = (!isRecastMode && Array.isArray(chat))
        ? chat
            .filter(m => m?.extra?.novelContinuationOrigin === 'original')
            .reduce((sum, m) => sum + Math.max(1, Number(m?.extra?.novelMergedChapterCount) || 1), 0)
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
    if (recastSourceChapter?.content) {
        recentTexts.push(stripNonStoryBlocks(recastSourceChapter.content).slice(0, 1200));
    } else if (anchorChapter?.content) {
        recentTexts.push(anchorChapter.content.slice(-700));
    }
    const recastTargetNames = isRecastMode
        ? (recastCfg.mappings || []).map(m => String(m?.toName || '').trim()).filter(Boolean)
        : [];
    if (recastTargetNames.length > 0) {
        recentTexts.push(recastTargetNames.join(' '));
    }
    const queryText = recentTexts.join('\n');

    const sections = [];
    const resolvedTitle = String(novelData?.title || ledger?.storyBlueprint?.title || '').trim();
    const novelTitle = resolvedTitle ? `《${resolvedTitle}》` : '当前长篇小说';
    const anchorLabel = anchorChapter?.title || `第 ${cutoff} ${chapterUnit}`;
    const targetLabel = `第 ${targetChapterIndex} ${chapterUnit}`;
    const isOriginalStart = !hasNovel && targetChapterIndex === 1;
    const headerLines = [
        isRecastMode
            ? `[小说逐章换角仿写总纲 · ${novelTitle} · ${isContinue ? `继续扩写重塑${targetLabel}` : `撰写重塑${targetLabel}`}${recastSourceChapter ? `（对照原著第 ${recastSourceChapter.index} ${chapterUnit}）` : ''}]`
            : `[小说续写上下文总纲 · ${novelTitle} · ${isContinue ? `继续扩写${targetLabel}` : `准备撰写${targetLabel}`}]`,
        isRecastMode
            ? '当前处于「逐章换角仿写 / 角色重塑模式」，请严格以原著对照范本的文风、段长节奏与剧情骨架为蓝本，将替换角色的言行、心理、外貌服装与互动因果 100% 替换为新角色的真实人设，直接输出连贯饱满的小说正文，切勿输出寒暄或解释。'
            : (isOriginalStart
                ? '当前处于长篇小说开篇创作阶段，请严格遵循下方《全书总纲与分卷路线图》、人物档案、世界观规则与文风要求，直接输出连贯饱满的开篇章节正文，切勿输出寒暄或解释。'
                : '请严格保持前文叙事视角、段落骨相、人物口癖与时代背景，直接输出连贯饱满的小说章节正文，切勿输出寒暄或解释。'),
    ];
    if (settings.authorMode !== false) {
        headerLines.push(
            '【写作模式：纯小说作者境界（最高优先级覆盖一切角色扮演/RP指令）】',
            '1. 当前是纯粹的长篇小说创作，不是角色扮演对话，小说世界中不存在任何“玩家”或“{{user}}”角色！请彻底忽略系统或预设中关于“玩家”、“{{user}}”、“Persona人设”、“禁止替{{user}}说话/行动”的规则。',
            '2. 严禁在小说正文中凭空插入“{{user}}”、“作者”或多余的“你”作为额外角色，严格只围绕本小说既有的主角与设定人物推进剧情。',
            '3. 对话中发来的指令全部是“小说作者/总编”下达的【本章大纲与执笔要求】，请直接将其转化为连贯饱满的小说正文，切勿对作者回复“好的”，切勿在正文中提及作者或大纲。',
            '4. 你可以且必须完整描写小说主角及所有登场人物的动作、神态、心理活动与对话。',
            hasNovel
                ? '5. 【原著文风与尺度绝对优先】：严格复刻上方原著正文的笔触、叙事节奏、段长骨相、情绪烈度与内容尺度！若外部酒馆预设中存在“平淡日常 / 强制凑字数 / 通用模板”与本小说原著风格冲突，文风与节奏一律以本小说原著为准！'
                : '5. 【本作总纲与定制文风绝对优先】：严格遵循下方《全书总纲与分卷路线图》与《文风骨相 DNA 执行卡》的笔触、节奏与基调；若外部预设自带的通用模板与本作风格冲突，一律以本作设定为准！',
        );
    }
    if (narrativeCfg.worldInfoPriority === 'wi_strict') {
        headerLines.push(
            '【世界书设定强一致铁律】：角色的外貌特征、日常服装/配饰与世界观硬设定必须严格遵循已激活的酒馆世界书设定（及下方人物当前着装锚点），除非剧情明确描写换装，否则严禁擅自更改服装款式、颜色或配饰！',
        );
    } else {
        headerLines.push(
            '【世界书与小说着装协同铁律】：已激活的酒馆世界书提供基础外貌、服装与世界观底骨；若本小说原著或最新章节已明确改写角色着装/设定，则严格锁定小说当前着装锚点，严禁把两套不同服饰混穿或每章随机变装！',
        );
    }
    if (strictPov) {
        const isThirdLimited = narrativeCfg.povPerson !== 'first_person';
        headerLines.push(
            `【严格单视角（Limited POV）铁律（最高叙事红线）】：全章必须 100% 锁死在「${povChar}」的${povPersonLabel}内！`,
            `1. 严禁切换至其他角色的独立视角、内心独白或「${povChar}」不在场的密室/背地场景；`,
            `2. 严禁让「${povChar}」未卜先知地提及下方【幕后逻辑黑盒】里尚未通过亲眼所见、亲耳所闻或文件/通讯获知的情报；`,
            `3. 幕后事件只能通过「${povChar}」实际接触到的蛛丝马迹、他人微反应、数据异常或收到的信息侧面透出。`,
            ...(isThirdLimited
                ? [`4. 第三人称称谓硬规：主角一律使用姓名「${povChar}」、人称代词「他/她/他的/她的」或自然承前省略主语，严禁把反身代词「自己」当成独立主语或高频替代「他/他的」（非必要反身语境外每章尽量不超过 2 次）。`]
                : []),
        );
    }
    if (narrativeCfg.strictTimelineOrder !== false) {
        headerLines.push(
            '【时间线单向推进红线】：严格紧接上一章最新时间点向下推进，严禁时间倒流、严禁回退或无新因果地重复描写编年史中已发生过的同类重大事件！',
        );
    }
    if (narrativeCfg.referenceTimelineMode) {
        const refLabel = narrativeCfg.referencePovLabel || '已完结基准时间线';
        const refCursor = Number(narrativeCfg.referenceCursorChapter || 0);
        headerLines.push(
            `【平行视角 · 基准时间线严密对齐铁律】：当前正在续写与【${refLabel}】平行的视角正文（已推进对齐至基准第 ${refCursor} 章）。凡涉及与基准视角的交集事件（通话内容、发送的照片/视频、见面经过、重大外勤或出行节点），必须 100% 严格遵循下方基准路标的时间顺序与事实细节，严禁提前剧透、严禁重复已发生节点！`,
        );
    }
    if (hasExternalLwbSummary) {
        headerLines.push(
            '【外部摘要协同分工】：外部记忆仅作过往事实参考；人物言行方式、说话长度与心理气质必须 100% 遵循下方《核心人物灵魂与防 OOC 档案》与原著原文，严禁将外部摘要里的概括词或关系标签脑补成霸道总裁/刻板里番模板！',
        );
    }
    if (anchorChapter && targetChapterIndex === activeAnchorIndex + 1 && !isContinue) {
        const closingTail = anchorChapter.content.replace(/\s+/g, ' ').trim().slice(-140);
        headerLines.push(
            `【严格续写锚点】：前文原著已完整演进至【${anchorLabel}】结尾（末尾句：“……${closingTail}”）。严禁回退或重写第 1~${activeAnchorIndex} ${chapterUnit}已发生的剧情！请直接紧接【${anchorLabel}】结尾处无缝向下推进，撰写【${targetLabel}】。`,
        );
    }
    sections.push(headerLines.join('\n'));

    // 1.2 Master Book Blueprint (L1 Premise & World Rules + L2 Active Volume & Completed Recaps)
    if (hasBlueprint) {
        const bpBlock = buildStoryBlueprintContextBlock(ledger.storyBlueprint, targetChapterIndex, {
            includeNextVolumeGuard: true,
        });
        if (bpBlock) sections.push(bpBlock);
    }

    // 1.25 Chapter-by-Chapter Role-Swap / Recast Protocol + Source Chapter Template + Pinned Target Profiles
    let recastPinnedBaseTitles = [];
    if (isRecastMode) {
        const recastBlock = buildRecastModePromptBlock({
            novelData,
            recastConfig: recastCfg,
            loreItems: unifiedLoreItems,
            includeSourceText: true,
            sourceChapterCount: 1,
            maxSourceChars: 5200,
        });
        if (recastBlock.text) {
            sections.push(recastBlock.text);
            recastPinnedBaseTitles = recastBlock.pinnedBaseTitles;
        }
    }

    // 1.5 Distilled Original Author Style DNA Card + Live Samples + Anti-Cliché Positive Replacement Rules
    if (hasStyleProfile) {
        const sp = ledger.styleProfile;
        const cleanStyleCard = sanitizeStyleCardText(sp.styleCard || '');
        const styleLines = ['【原著文风骨相 DNA 执行卡（最高文风权威——严格按此骨相、段长、节奏与尺度执笔）】'];
        if (sp.goldenExcerpts && String(sp.goldenExcerpts).trim()) {
            styleLines.push(
                '▸ 原著灵魂语感活样本（最高语感直觉标尺：优先模仿以下原文的断句节奏、对话口吻与动作穿插感，勿照抄情节）：',
                String(sp.goldenExcerpts).trim(),
            );
        }
        if (sp.fingerprintText) {
            styleLines.push('▸ 原著客观统计锚点（硬指标）：', sp.fingerprintText);
        }
        if (cleanStyleCard) {
            styleLines.push('▸ 终版文风骨相铁律：', cleanStyleCard);
        }
        styleLines.push(buildAntiClichePromptGuidance(settings.clicheBlacklist));
        sections.push(styleLines.join('\n'));
    } else {
        sections.push(buildAntiClichePromptGuidance(settings.clicheBlacklist));
    }

    // 1.8 Core Character 4-Dimension Soul & Anti-OOC Profiles (Bridges Canon Foundation + Fanfic Evolution)
    if (hasCharacters) {
        const activeChars = ledger.characters
            .filter(c => c && c.name)
            .slice(0, 12);
        if (activeChars.length > 0) {
            const charLines = [
                '【核心人物 4 维灵魂与防 OOC 档案（最高人物权威——100% 锁死本场人物真实性格、着装与当前阶段状态；若上文世界书包含无关百科或未出场角色词条，严禁被其串戏带偏；人物情绪与态度必须按当前章节进度循序渐进，严禁无铺垫光速崩坏或脸谱化叫骂）】',
            ];
            for (const ch of activeChars) {
                const roleSuffix = ch.role ? `（${ch.role}）` : '';
                charLines.push(`◆ ${ch.name}${roleSuffix}`);
                if (ch.canonFoundation) charLines.push(`  · 原作底骨与能力：${ch.canonFoundation}`);
                if (ch.currentAppearance) charLines.push(`  · 👔 当前外观与着装锚点（未明确换装前必须保持一致）：${ch.currentAppearance}`);
                if (ch.currentSituation) charLines.push(`  · 当前处境与关系：${ch.currentSituation}`);
                if (ch.voiceAndQuotes) charLines.push(`  · 原著言行与声线锚点：${ch.voiceAndQuotes}`);
                if (ch.oocRedLines) charLines.push(`  · 🚫 绝对 OOC 红线：${ch.oocRedLines}`);
            }
            sections.push(charLines.join('\n'));
        }
    }

    // 2. Tier 1: Active Timeline Chronicle, World States & Recent Chapter Summaries (Highest Factual Authority)
    const activeChronicle = (ledger?.chronicle || [])
        .filter(e => Number(e.startChapter || 0) < targetChapterIndex)
        .sort((a, b) => (a.startChapter || 0) - (b.startChapter || 0))
        .slice(-30);
    const activeStates = resolveTimelineWorldStates(ledger?.worldStates || [], targetChapterIndex - 1);
    const activeSummaries = (ledger?.summaries || [])
        .filter(s => Number(s.chapterIndex || 0) < targetChapterIndex)
        .sort((a, b) => a.chapterIndex - b.chapterIndex)
        .slice(-(Number(settings.maxRecentSummaries) || 6));

    // 0-API continuous bridge for unarchived chapters (original gap + continued chapters missing `<novel_state>`)
    const continuedFromChat = [];
    if (Array.isArray(chat)) {
        let lastOrigFloor = -1;
        chat.forEach((m, i) => {
            if (m?.extra?.novelContinuationOrigin === 'original') lastOrigFloor = i;
        });
        let seq = 0;
        chat.forEach((m, i) => {
            if (!isContinuedNovelFloor(m, i, lastOrigFloor)) return;
            seq += 1;
            const chIdx = Number(m?.extra?.novelChapterIndex) || (activeAnchorIndex + seq);
            if (chIdx < targetChapterIndex) {
                continuedFromChat.push({
                    index: chIdx,
                    title: m?.extra?.novelChapterTitle || `第 ${chIdx} ${chapterUnit}`,
                    content: String(m.mes || ''),
                    authorOutline: String(m?.extra?.novelAuthorOutline || ''),
                });
            }
        });
    }
    const summaryChapterIds = activeSummaries.map(s => Number(s.chapterIndex));
    const unarchivedBridge = buildUnarchivedRecentChaptersBridge({
        novelData,
        continuedChapters: continuedFromChat,
        ledger,
        upToChapterIndex: targetChapterIndex - 1,
        excludeFlashback,
        excludeChapterIndices: summaryChapterIds,
        maxItems: 12,
    });

    if (activeChronicle.length > 0 || activeStates.length > 0 || activeSummaries.length > 0 || unarchivedBridge.count > 0) {
        const tier1Lines = ['【第一优先级：当前时间线已确认状态与前情提要（最高事实权威）】'];
        if (activeChronicle.length > 0) {
            const refMode = Boolean(narrativeCfg.referenceTimelineMode);
            const refCursor = Number(narrativeCfg.referenceCursorChapter || 0);
            const refLookahead = Math.max(2, Math.min(20, Number(narrativeCfg.referenceLookaheadChapters) || 8));
            const refChapters = (novelData?.chapters || []).filter(c => c && c.timelineRole === 'reference');
            const refChapterSet = new Set(refChapters.map(c => Number(c.index)));
            const isRefEvt = (e) => e && (e.timelinePhase === 'reference' || (refMode && refChapterSet.has(Number(e.startChapter))));

            const mainEvts = activeChronicle.filter(e => e.timelinePhase !== 'flashback' && !isRefEvt(e));
            const refEvts = refMode ? (ledger?.chronicle || []).filter(isRefEvt).sort((a, b) => (a.startChapter || 0) - (b.startChapter || 0)) : [];
            const flashbackEvts = activeChronicle.filter(e => e.timelinePhase === 'flashback');

            if (refMode) {
                const refLabel = narrativeCfg.referencePovLabel || '已完结基准时间线';
                const doneRef = refEvts.filter(e => refCursor > 0 && Number(e.endChapter || e.startChapter || 0) <= refCursor);
                const nextRef = refEvts.filter(e => {
                    const st = Number(e.startChapter || 0);
                    const ed = Number(e.endChapter || st);
                    return ed > refCursor && st <= refCursor + refLookahead;
                });
                const nextRefChs = refChapters
                    .filter(c => Number(c.index) > refCursor && Number(c.index) <= refCursor + Math.min(3, refLookahead))
                    .sort((a, b) => Number(a.index) - Number(b.index));
                tier1Lines.push(`▸ 🧭 平行视角基准时间线对齐（${refLabel} · 已对齐至第 ${refCursor} 章）：`);
                if (doneRef.length > 0) {
                    tier1Lines.push(`  · ✅ 已写完的基准节点（严禁重写）：${doneRef.map(e => `${e.chapterRange}${e.title}`).join(' → ')}`);
                }
                for (const evt of nextRef) {
                    tier1Lines.push(`  · 🎯 即将衔接基准节点 (${evt.chapterRange}) ${evt.title}：${evt.summary}`);
                }
                for (const ch of nextRefChs) {
                    const body = stripNonStoryBlocks(ch.content || '').replace(/\s+/g, ' ').trim();
                    tier1Lines.push(`  · 📄 [基准#${ch.index} ${ch.title}]：${body.slice(0, 360)}${body.length > 360 ? '……' : ''}`);
                }
            }
            if (mainEvts.length > 0) {
                tier1Lines.push(strictPov
                    ? `▸ 主线剧情编年史（已确认时间线 · 请严格区分「${povChar}已知」与「幕后盲区」）：`
                    : '▸ 全本原著剧情编年史（客观事实与信息差）：');
                for (const evt of mainEvts) {
                    const timePart = evt.timeLabel ? `[${evt.timeLabel}] ` : '';
                    const knownPart = strictPov && evt.povKnown ? ` ｜ ${povChar}已知：${evt.povKnown}` : '';
                    const blindPart = strictPov && evt.povBlindspot ? ` ｜ 🔒幕后黑盒（${povChar}未知，严禁直接写出）：${evt.povBlindspot}` : '';
                    const gapPart = (!knownPart && !blindPart && evt.infoGap) ? ` ｜ 信息差：${evt.infoGap}` : '';
                    tier1Lines.push(`  - (${evt.chapterRange || `#${evt.startChapter}`}) ${timePart}${evt.title}：${evt.summary}${knownPart}${blindPart}${gapPart}`);
                }
            }
            if (flashbackEvts.length > 0) {
                tier1Lines.push(strictPov
                    ? `▸ 🔒 倒叙/他视角幕后逻辑黑盒（仅供维持逻辑一致性参考，严禁切视角描写或让「${povChar}」未卜先知）：`
                    : '▸ 倒叙/补完视角记录（属过往补叙，切勿当作最新时间点回退）：');
                for (const evt of flashbackEvts) {
                    const timePart = evt.timeLabel ? `[${evt.timeLabel}] ` : '';
                    tier1Lines.push(`  - (${evt.chapterRange || `#${evt.startChapter}`}·倒叙) ${timePart}${evt.title}：${evt.summary}`);
                }
            }
        }
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
        if (unarchivedBridge.count > 0) {
            tier1Lines.push(`▸ 📌 未归档近期章节实录（第${unarchivedBridge.startChapter}~${unarchivedBridge.endChapter}${chapterUnit} · 确保不断档、不重复已写情节）：`);
            for (const line of unarchivedBridge.lines) {
                tier1Lines.push(`  ${line}`);
            }
        }
        sections.push(tier1Lines.join('\n'));
    }

    // 3. Foreshadowing Hooks (Timeline-isolated)
    const openHooks = resolveTimelineHooks(ledger?.hooks || [], targetChapterIndex - 1);
    if (openHooks.length > 0) {
        const pinned = openHooks.filter(h => h.status === 'pinned');
        const unpinned = openHooks.filter(h => h.status !== 'pinned').slice(-8);
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
    // Skipped in Recast Mode so unrelated late-novel chapters never leak into Recast Chapter N.
    if (hasNovel && !isRecastMode && queryText.trim()) {
        const hits = searchOriginalChaptersCjk(queryText, novelData.chapters, {
            cutoffChapterIndex: anchorChapter?.index || cutoff,
            excludeTailCount: hasOriginalFloorInChat ? Math.max(1, mountedOriginalCount) : 1,
            excludeFlashback,
            excludeReference: Boolean(narrativeCfg.referenceTimelineMode),
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

    // 5. Tier 3: Unified Clean Lore Library (Global Reusable Fandom Packs + Per-Chat Canon DB)
    if (hasCanon) {
        const tier3Lines = [];
        if (worldCores.length > 0) {
            let coreBudget = 2400;
            for (const wc of worldCores) {
                if (coreBudget < 200 || !wc?.digest) continue;
                const clipped = wc.digest.length > coreBudget ? `${wc.digest.slice(0, coreBudget)}……` : wc.digest;
                tier3Lines.push(`▸ 作品基础世界观总纲（${wc.packName || '全局资料库'}）：\n${clipped}`);
                coreBudget -= clipped.length;
            }
        }
        if (unifiedLoreItems.length > 0 && queryText.trim()) {
            const pinnedSet = new Set(recastPinnedBaseTitles);
            const rawHits = searchCanonDatabaseCjk(queryText, unifiedLoreItems, {
                topK: (Number(settings.maxCanonHits) || 4) + pinnedSet.size,
                maxItemChars: 1400,
                pinnedNames: recastTargetNames,
            });
            const canonHits = rawHits
                .filter(it => !(pinnedSet.has(it.baseTitle || it.title) && it.chunkKind === 'core'))
                .slice(0, Number(settings.maxCanonHits) || 4);
            if (canonHits.length > 0) {
                tier3Lines.push('▸ 按本章内容精准召回的原作人物/势力/地理设定（完整核心档案，防 OOC 与外貌服装错乱）：');
                for (const item of canonHits) {
                    tier3Lines.push(`  - [${item.category}] ${item.title}：\n${item.content}`);
                }
            }
        }
        if (tier3Lines.length > 0) {
            sections.push([
                '【第三优先级：同人补充原作设定数据库（全局纯净资料库 · 注意蝴蝶效应保护：原作设定提供世界观、外貌服装、能力与性格底骨；若与【第一/第二优先级】中本作品已改写的同人剧情冲突，严格以本作品已发生的事实为准！）】',
                ...tier3Lines,
            ].join('\n\n'));
        }
    }

    // 6. Fallback Style & Cliffhanger Anchor when no original chapter floor is mounted in chat
    if (anchorChapter && !hasOriginalFloorInChat && !isRecastMode) {
        sections.push(
            `【原著断更处锚点 · 第 ${anchorChapter.index} ${chapterUnit}《${anchorChapter.title}》结尾原文（请严格模仿其文风笔触紧接着往下写）】\n${anchorChapter.content.slice(-1500)}`,
        );
    }

    return sections.join('\n\n');
}

/**
 * Builds the dedicated `depth = 0` trailer instruction so the LLM reliably emits
 * `<novel_state>` (summary, worldbook, and hooks) at the very end of the reply —
 * even when external presets wrap story output in `<game>...</game>` or add post-history rules.
 */
export function buildNovelStateTrailerPrompt({
    chat,
    novelData,
    ledger,
    settings,
    generationType = 'normal',
}) {
    if (!settings?.enabled || !settings?.enableAutoStateBlock || generationType === 'continue') {
        return '';
    }
    const hasNovel = Boolean(novelData?.chapters?.length);
    const hasBlueprint = hasStoryBlueprintData(ledger?.storyBlueprint);
    const hasLedger = Boolean(
        ledger && (ledger.summaries?.length || ledger.chronicle?.length || ledger.characters?.length || ledger.worldStates?.length || ledger.hooks?.length || ledger.styleProfile?.styleCard || hasBlueprint),
    );
    if (!hasNovel && !hasLedger) return '';

    const nCfg = ledger?.narrativeConfig || {};
    const recastCfg = nCfg.recast || null;
    const isRecastMode = Boolean(recastCfg?.enabled && hasNovel);
    const excludeFlashback = nCfg.excludeFlashbackFromAnchor !== false;
    const targetChapterIndex = resolveCurrentTargetChapterIndex(chat, novelData, false, excludeFlashback, recastCfg);
    const cutoff = Number(novelData?.cutoffChapterIndex || novelData?.totalChapters || 0);
    const anchorChapter = (!isRecastMode && hasNovel && cutoff > 0) ? resolveActiveAnchorChapter(novelData, excludeFlashback) : null;
    const recastSrcCh = isRecastMode ? resolveRecastSourceChapter(novelData, recastCfg, 0) : null;
    const chapterUnit = (recastSrcCh?.title || anchorChapter?.title) && /节\s*$/.test(String(recastSrcCh?.title || anchorChapter?.title).trim()) ? '节' : '章';
    const targetLabel = `第 ${targetChapterIndex} ${chapterUnit}`;
    const openHooks = resolveTimelineHooks(ledger?.hooks || [], targetChapterIndex - 1).slice(-8);
    const refAutoOn = Boolean(nCfg.referenceTimelineMode && nCfg.autoAdvanceRefCursor !== false);
    const curRefCursor = Number(nCfg.referenceCursorChapter || 0);
    const recastFromNames = isRecastMode ? (recastCfg.mappings || []).map(m => m?.fromName).filter(Boolean) : [];
    const recastToNames = isRecastMode ? (recastCfg.mappings || []).map(m => m?.toName).filter(Boolean) : [];

    const lines = [
        '【落笔前最后自检（紧贴正文生效，防长上下文稀释）】',
        '1. 人物严格遵循前文《核心人物防 OOC 档案》当前阶段的气质、说话长度与着装，严禁被无关世界书词条串戏，严禁未铺垫就光速黑化或脸谱化；',
        '2. 笔触严格对齐《灵魂语感活样本》与《文风骨相执行卡》，严禁把原著平实口语擅自润色升格为 AI 书面修饰腔（大幅砍掉“大开大合/源源不断/毫不保留/骤然/猛烈/彻底/狠狠/硬生生/径直/随即/晶莹/冰冷/滚烫/高亢/回荡/弥漫”等高频 AI 修饰语，杜绝“如遭雷击/冻结成冰/狰狞邪异/裂开一道弧度/声音沙哑/喉结滚动/空气仿佛凝固”等网文八股），也不要用“眼看着/只见/随着一声”起手。',
        ...(isRecastMode ? [
            `3. 【换角仿写终检】：正文绝不残留被替换原名（${recastFromNames.join('、') || '原角色'}）；新角色（${recastToNames.join('、') || '目标角色'}）的外貌着装、性格底色与对话语气 100% 遵循其纯净资料库档案（严禁机械改名换皮 OOC），同时保持原著第 ${recastSrcCh?.index || targetChapterIndex} ${chapterUnit}的段长与叙事节奏。`,
        ] : []),
        '',
        '【单次调用自动归档指令（强制末段附带 · 前端自动隐藏入库）】',
        '写完本章正文后，必须附带完整闭合的 `<novel_state>...</novel_state>` XML 块（直接输出尖括号标签，不要加反引号，切勿省略）：若外部预设要求用 `<game>...</game>` 包裹整条回复，请将 `<novel_state>...</novel_state>` 紧贴写在 `</game>` 闭合标签**紧前面**（或紧后面），前端会自动解析并隐藏，绝不影响正文排版！',
        '请以 `<novel_state>` 开头、`</novel_state>` 结尾，内部按顺序包含以下子标签：',
        `- \`<chapter_summary>${targetLabel}的精要四要素总结（100~180字：写明时间地点、核心事件经过与关键对话博弈、人物关系/底线/筹码变动、本章结尾定格落点，绝不空泛）</chapter_summary>\``,
        '- `<worldbook>` …… `</worldbook>` 内按行填写：`- 人物|角色名：本章结束时的最新处境/持有物/关系变化（仅写本章有变动的条目；无则写无）`；若有换装再写 `- 外观|角色名：本章结束时的当前着装/配饰变动（无变化省略）`',
        '- `<hooks>` …… `</hooks>` 内按行填写：`- [新伏笔] 本章新埋下的悬念、约定或隐患（无则写无）` 与 `- [已填坑] 本章已揭晓、完成或回收的旧伏笔（尽量沿用下方已有伏笔原话；无则写无）`',
        ...(refAutoOn
            ? [`- \`<ref_cursor>写完本章后已对齐覆盖的【${nCfg.referencePovLabel || '基准时间线'}】最大章号（纯数字，当前为 ${curRefCursor}；若本章推进并覆盖了后续基准章节请填新章号，否则保持 ${curRefCursor}）</ref_cursor>\``]
            : []),
        ...(isRecastMode && recastCfg.autoAdvanceCursor !== false && recastSrcCh
            ? [`- \`<recast_cursor>${recastSrcCh.index}</recast_cursor>\`（纯数字：本章完成对照重塑的原著章号，用于自动推进到下一章）`]
            : []),
    ];
    if (openHooks.length > 0) {
        lines.push('▸ 当前待填伏笔参考（若本章已回收，请在 `<hooks>` 中用 `[已填坑]` 标出）：');
        for (const h of openHooks) {
            lines.push(`  - ${h.status === 'pinned' ? '🎯' : '🔮'} ${h.content}`);
        }
    }
    return lines.join('\n');
}
