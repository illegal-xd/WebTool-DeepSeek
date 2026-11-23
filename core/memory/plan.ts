import type { Memory, MemoryScope } from '../types';
import { normalizeMemoryScope } from '../weighting';
import { estimateTokens, formatMemoryLine, getMemoryBudget, selectMemories } from './selector';

/**
 * 记忆注入计划（发送前预览用）。
 *
 * 与 fetch-hook 的注入路径共用 `selectMemories` 与同一预算公式，
 * 保证「预览看到的」与「实际注入的」在相同输入下一致。
 */
export interface MemoryPlanItem {
  memory: Memory;
  tokens: number;
  scope: MemoryScope;
}

export interface MemoryPlan {
  items: MemoryPlanItem[];
  totalTokens: number;
  budget: number;
  byScope: Record<MemoryScope, number>;
}

export interface MemoryPlanOptions {
  tokenBudget?: number;
  /** 用户在本条消息中手动剔除的记忆 id。 */
  excludeIds?: ReadonlySet<number>;
}

const EMPTY_SCOPE_TOKENS = (): Record<MemoryScope, number> => ({
  permanent: 0,
  contextual: 0,
  temporary: 0,
});

export function planMemoryInjection(
  prompt: string,
  memories: readonly Memory[],
  options?: MemoryPlanOptions,
): MemoryPlan {
  const excludeIds = options?.excludeIds;
  const candidates = excludeIds && excludeIds.size > 0
    ? memories.filter((memory) => memory.id == null || !excludeIds.has(memory.id))
    : memories;

  const budget = getMemoryBudget(estimateTokens(prompt), options?.tokenBudget);
  const selected = selectMemories(prompt, [...candidates], { budget });

  const byScope = EMPTY_SCOPE_TOKENS();
  const items: MemoryPlanItem[] = selected.map((memory) => {
    const tokens = estimateTokens(formatMemoryLine(memory));
    const scope = normalizeMemoryScope(memory);
    byScope[scope] += tokens;
    return { memory, tokens, scope };
  });

  return {
    items,
    totalTokens: items.reduce((sum, item) => sum + item.tokens, 0),
    budget,
    byScope,
  };
}
