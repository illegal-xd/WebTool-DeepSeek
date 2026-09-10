import type { Memory, MemoryScope } from '../types';
import { MEMORY_KEYWORD_MAX_HITS, MEMORY_SINGLE_ENTRY_MAX_RATIO, MEMORY_TOKEN_BUDGET, STOP_WORDS } from '../constants';
import { memoryWeight, normalizeMemoryScope } from '../weighting';

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null;

export function segmentText(text: string): string[] {
  if (segmenter) {
    return [...segmenter.segment(text)]
      .filter((s) => s.isWordLike)
      .map((s) => s.segment.toLowerCase())
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  }
  return text
    .toLowerCase()
    .split(/[\s,，。！？；：、\-_/]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

export function estimateTokens(text: string): number {
  // DeepSeek-V3 BPE tokenizer: avg ~0.25 tokens per char for mixed CJK+English.
  // Empirically validated (1.42x overestimate vs actual — safe and simple).
  // 0.25 + 0.1 防止误差导致超长
  return Math.ceil(text.length * 0.35);
}

/**
 * 关键词计分。命中数一律饱和到 MEMORY_KEYWORD_MAX_HITS，避免长文本按词频
 * 无界累加（实测同一主题下 6k 字符长文可达 +6000，短记忆仅 +25）。
 * 计分权重保持 tag > name > content 的相对关系。
 */
export function keywordScore(promptWords: string[], memory: Memory): number {
  const promptSet = new Set(promptWords);

  let tagHits = 0;
  for (const tag of memory.tags) {
    const tagLower = tag.toLowerCase();
    if (tagLower.length > 1 && promptSet.has(tagLower)) tagHits++;
    for (const pw of promptWords) {
      if (pw.length > 2 && tagLower.includes(pw) && tagLower !== pw) tagHits += 0.5;
    }
  }

  const nameWords = segmentText(memory.name);
  let nameHits = 0;
  for (const w of nameWords) {
    if (promptSet.has(w)) nameHits++;
  }

  const contentWords = segmentText(memory.content);
  let contentHits = 0;
  for (const w of contentWords) {
    if (promptSet.has(w)) contentHits++;
  }

  return (
    Math.min(tagHits, MEMORY_KEYWORD_MAX_HITS.tag) * 20 +
    Math.min(nameHits, MEMORY_KEYWORD_MAX_HITS.name) * 15 +
    Math.min(contentHits, MEMORY_KEYWORD_MAX_HITS.content) * 5
  );
}

function decayScore(memory: Memory): number {
  const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / 86_400_000;
  const freshness = Math.max(0, 10 - daysSinceAccess * 0.1);
  return Math.min(memory.accessCount, 20) + freshness;
}

export interface SelectOptions {
  budget?: number;
}

export function getMemoryBudget(promptTokens: number, baseBudget = MEMORY_TOKEN_BUDGET): number {
  if (promptTokens > 3000) {
    return Math.max(800, baseBudget - Math.floor((promptTokens - 3000) * 0.2));
  }
  return baseBudget;
}

/**
 * Scope layer budget ratios: permanent 40%, contextual 45%, temporary 15%.
 * When a layer has no data, its budget overflows to the next layer.
 */
const SCOPE_BUDGET_RATIO: Record<string, number> = {
  permanent: 0.4,
  contextual: 0.45,
  temporary: 0.15,
};

const SCOPE_ORDER: MemoryScope[] = ['permanent', 'contextual', 'temporary'];

interface ScoredEntry {
  memory: Memory;
  score: number;
  cost: number;
}

/** 按 scope 分组打分并按分数降序；成本超过单条上限的记忆先剔除（数据不受影响）。 */
function scoreCandidates(
  candidates: Memory[],
  promptWords: string[],
  singleEntryCap: number,
): Map<MemoryScope, ScoredEntry[]> {
  const byScope = new Map<MemoryScope, ScoredEntry[]>();
  for (const memory of candidates) {
    const cost = estimateTokens(formatMemoryLine(memory));
    if (cost > singleEntryCap) continue;
    const scope = normalizeMemoryScope(memory);
    if (!byScope.has(scope)) byScope.set(scope, []);
    const score = memoryWeight(memory, keywordScore(promptWords, memory)) + decayScore(memory);
    byScope.get(scope)!.push({ memory, score, cost });
  }

  // Sort each scope group by score descending (pinned get 1000 bonus → naturally first)
  for (const group of byScope.values()) {
    group.sort((a, b) => b.score - a.score);
  }
  return byScope;
}

/** Phase 1 分层分配（每层预算切片，剩余溢出下一层）+ Phase 2 按分数填充剩余预算。 */
function allocateLayered(
  byScope: Map<MemoryScope, ScoredEntry[]>,
  masterSorted: ScoredEntry[],
  budget: number,
): Memory[] {
  const selected: Memory[] = [];
  const selectedSet = new Set<number | undefined>();

  const tryAdd = (entry: ScoredEntry, remaining: number): number => {
    const memId = entry.memory.id;
    if (memId != null && selectedSet.has(memId)) return remaining;
    if (remaining - entry.cost < 0 && selected.length > 0) return remaining;
    selected.push(entry.memory);
    if (memId != null) selectedSet.add(memId);
    return remaining - entry.cost;
  };

  let overflowBudget = 0;
  for (const scope of SCOPE_ORDER) {
    const group = byScope.get(scope);
    if (!group || group.length === 0) {
      // No data for this scope → overflow its budget to the next
      overflowBudget += Math.floor(budget * SCOPE_BUDGET_RATIO[scope]);
      continue;
    }

    let remaining = Math.floor(budget * SCOPE_BUDGET_RATIO[scope]) + overflowBudget;
    overflowBudget = 0;

    for (const entry of group) {
      const next = tryAdd(entry, remaining);
      if (next === remaining) break; // doesn't fit
      remaining = next;
    }

    // Unused scope budget overflows to the next layer
    overflowBudget = remaining;
  }

  if (overflowBudget > 0) {
    for (const entry of masterSorted) {
      overflowBudget = tryAdd(entry, overflowBudget);
    }
  }

  return selected;
}

export function selectMemories(
  prompt: string,
  allMemories: Memory[],
  options?: SelectOptions,
): Memory[] {
  if (allMemories.length === 0) return [];

  const { budget = MEMORY_TOKEN_BUDGET } = options ?? {};

  // 单条上限：超过预算 MEMORY_SINGLE_ENTRY_MAX_RATIO 的记忆直接不参与（数据不受影响），
  // 否则「首条无条件加入」的兜底会让一条长文档记忆把整轮预算撑爆并挤掉其他记忆。
  const singleEntryCap = Math.floor(budget * MEMORY_SINGLE_ENTRY_MAX_RATIO);
  const byScope = scoreCandidates(allMemories, segmentText(prompt), singleEntryCap);

  // Flat master list for easy overflow fallback (sorted by score)
  const masterSorted = [...byScope.values()]
    .flat()
    .sort((a, b) => b.score - a.score);

  return allocateLayered(byScope, masterSorted, budget);
}

function sanitizeContent(text: string): string {
  return text
    .replace(/｜DSML｜/g, '|DSML|')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function formatMemoryLine(m: Memory): string {
  const idPrefix = m.id != null ? `#${m.id} ` : '';
  return `- ${idPrefix}[${m.type}] ${sanitizeContent(m.name)}: ${sanitizeContent(m.content)}`;
}

export function formatMemoriesBlock(memories: Memory[]): string {
  return memories.map(formatMemoryLine).join('\n');
}
