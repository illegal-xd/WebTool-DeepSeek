import type { Memory, MemoryScope } from '../types';
import { normalizeMemoryScope } from '../weighting';
import { estimateTokens, formatMemoryLine, segmentText } from './selector';
import { MEMORY_SINGLE_ENTRY_MAX_RATIO } from '../constants';
import { planMemoryInjection } from './plan';

/**
 * 记忆体检：把「注入成本 / 预算占用 / 近似重复」变成可看的数字。
 *
 * 只做纯计算，不修改任何记忆——近似项仅作为合并建议，由用户自行编辑。
 */
export interface DuplicatePair {
  a: Memory;
  b: Memory;
  similarity: number;
}

export interface MemoryHealth {
  total: number;
  archivedCount: number;
  /** 各层级已存记忆的 token 总量（全库，不代表实际注入）。 */
  scopeTokens: Record<MemoryScope, number>;
  /** 典型注入量：空输入下的实际选中 token 与预算。 */
  injectionTokens: number;
  injectionBudget: number;
  /** 单条超过预算 50% 而永远无法注入的记忆数量。 */
  overCapCount: number;
  duplicates: DuplicatePair[];
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.55;
const MAX_DUPLICATE_PAIRS = 20;

export function textSimilarity(a: string, b: string): number {
  const setA = new Set(segmentText(a));
  const setB = new Set(segmentText(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/** 找出内容高度重合的记忆对（用于手动合并，不自动改动数据）。 */
export function findDuplicateMemories(
  memories: readonly Memory[],
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
): DuplicatePair[] {
  const tokenSets = memories.map((memory) => new Set(segmentText(`${memory.name} ${memory.content}`)));
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < memories.length; i += 1) {
    for (let j = i + 1; j < memories.length; j += 1) {
      const setA = tokenSets[i];
      const setB = tokenSets[j];
      if (setA.size === 0 || setB.size === 0) continue;
      let intersection = 0;
      for (const token of setA) if (setB.has(token)) intersection += 1;
      const similarity = intersection / (setA.size + setB.size - intersection);
      if (similarity >= threshold) pairs.push({ a: memories[i], b: memories[j], similarity });
    }
  }

  return pairs
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, MAX_DUPLICATE_PAIRS);
}

export function computeMemoryHealth(
  memories: readonly Memory[],
  options?: { tokenBudget?: number; archivedCount?: number },
): MemoryHealth {
  const scopeTokens: Record<MemoryScope, number> = { permanent: 0, contextual: 0, temporary: 0 };
  for (const memory of memories) {
    scopeTokens[normalizeMemoryScope(memory)] += estimateTokens(formatMemoryLine(memory));
  }

  const plan = planMemoryInjection('', memories, { tokenBudget: options?.tokenBudget });
  const overCap = Math.floor(plan.budget * MEMORY_SINGLE_ENTRY_MAX_RATIO);
  const overCapCount = memories.filter((memory) => estimateTokens(formatMemoryLine(memory)) > overCap).length;

  return {
    total: memories.length,
    archivedCount: options?.archivedCount ?? 0,
    scopeTokens,
    injectionTokens: plan.totalTokens,
    injectionBudget: plan.budget,
    overCapCount,
    duplicates: findDuplicateMemories(memories),
  };
}
