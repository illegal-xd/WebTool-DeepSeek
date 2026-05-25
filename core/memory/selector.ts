import type { Memory, MemoryScope } from '../types';
import { MEMORY_TOKEN_BUDGET, STOP_WORDS } from '../constants';
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

function keywordScore(promptWords: string[], memory: Memory): number {
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

  return tagHits * 20 + nameHits * 15 + contentHits * 5;
}

function decayScore(memory: Memory): number {
  const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / 86_400_000;
  const freshness = Math.max(0, 10 - daysSinceAccess * 0.1);
  return Math.min(memory.accessCount, 20) + freshness;
}

export interface SelectOptions {
  budget?: number;
  identityOnly?: boolean;
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

export function selectMemories(
  prompt: string,
  allMemories: Memory[],
  options?: SelectOptions,
): Memory[] {
  if (allMemories.length === 0) return [];

  const { budget = MEMORY_TOKEN_BUDGET, identityOnly = false } = options ?? {};

  const candidates = identityOnly
    ? allMemories.filter((m) => m.type === 'user' || m.type === 'feedback' || m.pinned)
    : allMemories;

  if (candidates.length === 0) return [];

  const promptWords = segmentText(prompt);

  // Group candidates by scope and compute scores
  const byScope = new Map<MemoryScope, Array<{ memory: Memory; score: number; cost: number }>>();
  for (const memory of candidates) {
    const scope = normalizeMemoryScope(memory);
    if (!byScope.has(scope)) byScope.set(scope, []);
    const score = memoryWeight(memory, keywordScore(promptWords, memory)) + decayScore(memory);
    const cost = estimateTokens(formatMemoryLine(memory));
    byScope.get(scope)!.push({ memory, score, cost });
  }

  // Sort each scope group by score descending (pinned get 1000 bonus → naturally first)
  for (const group of byScope.values()) {
    group.sort((a, b) => b.score - a.score);
  }

  // Also keep a flat master list for easy overflow fallback (sorted by score)
  const masterSorted = [...byScope.values()]
    .flat()
    .sort((a, b) => b.score - a.score);

  const selected: Memory[] = [];
  const selectedSet = new Set<number | undefined>();

  const tryAdd = (entry: { memory: Memory; cost: number; score: number }, remaining: number): number => {
    const memId = entry.memory.id;
    if (memId != null && selectedSet.has(memId)) return remaining;
    if (remaining - entry.cost < 0 && selected.length > 0) return remaining;
    selected.push(entry.memory);
    if (memId != null) selectedSet.add(memId);
    return remaining - entry.cost;
  };

  // Phase 1: Layered allocation — each scope gets its budget slice
  let overflowBudget = 0;
  for (const scope of SCOPE_ORDER) {
    const group = byScope.get(scope);
    if (!group || group.length === 0) {
      // No data for this scope → overflow its budget to the next
      overflowBudget += Math.floor(budget * SCOPE_BUDGET_RATIO[scope]);
      continue;
    }

    const scopeBudget = Math.floor(budget * SCOPE_BUDGET_RATIO[scope]) + overflowBudget;
    overflowBudget = 0;
    let remaining = scopeBudget;

    for (const entry of group) {
      const next = tryAdd(entry, remaining);
      if (next === remaining) break; // doesn't fit
      remaining = next;
    }

    // Unused scope budget overflows to the next layer
    overflowBudget = remaining;
  }

  // Phase 2: If budget remains, add any remaining candidates by score
  if (overflowBudget > 0) {
    for (const entry of masterSorted) {
      overflowBudget = tryAdd(entry, overflowBudget);
    }
  }

  return selected;
}

function sanitizeContent(text: string): string {
  return text.replace(/｜DSML｜/g, '|DSML|');
}

export function formatMemoryLine(m: Memory): string {
  const idPrefix = m.id != null ? `#${m.id} ` : '';
  return `- ${idPrefix}[${m.type}] ${sanitizeContent(m.name)}: ${sanitizeContent(m.content)}`;
}

export function formatMemoriesBlock(memories: Memory[]): string {
  if (memories.length === 0) return '(暂无记忆)';
  return memories.map(formatMemoryLine).join('\n');
}
