import type { MemoryScope, MemoryType } from '../types';
import { getLocalValue, setLocalValue } from '../storage/chrome';

const STORAGE_KEY = 'webtool_deepseek_memory_candidates';
const MAX_CANDIDATES = 100;

export type MemoryCandidateStatus = 'pending' | 'accepted' | 'dismissed';

/**
 * 被动记忆候选队列。
 *
 * 从对话中提炼的候选记忆只进入这里，必须由用户在侧边栏逐条确认才写入记忆库——
 * 绝不自动落库，避免把规则或模型的误判变成长期记忆污染。
 */
export interface MemoryCandidate {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  name: string;
  content: string;
  tags: string[];
  /** 命中的提炼依据（展示给用户判断可信度）。 */
  reason: string;
  /** 来源原句。 */
  sourceText: string;
  createdAt: number;
  status: MemoryCandidateStatus;
}

export async function getMemoryCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidate[]> {
  const all = await readCandidates();
  return status ? all.filter((candidate) => candidate.status === status) : all;
}

/** 追加候选并去重（同内容 pending 候选只保留一条）。返回新增条数。 */
export async function addMemoryCandidates(inputs: MemoryCandidate[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const current = await readCandidates();
  const seen = new Set(current.filter((item) => item.status === 'pending').map(normalizeKey));
  const fresh: MemoryCandidate[] = [];
  for (const input of inputs) {
    const key = normalizeKey(input);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(input);
  }
  if (fresh.length === 0) return 0;
  await writeCandidates([...current, ...fresh].slice(-MAX_CANDIDATES));
  return fresh.length;
}

export async function setMemoryCandidateStatus(id: string, status: MemoryCandidateStatus): Promise<void> {
  const current = await readCandidates();
  await writeCandidates(current.map((item) => (item.id === id ? { ...item, status } : item)));
}

export async function removeMemoryCandidate(id: string): Promise<void> {
  const current = await readCandidates();
  await writeCandidates(current.filter((item) => item.id !== id));
}

function normalizeKey(candidate: Pick<MemoryCandidate, 'name' | 'content'>): string {
  return `${candidate.name.trim().toLowerCase()}::${candidate.content.trim().toLowerCase()}`;
}

function readCandidates(): Promise<MemoryCandidate[]> {
  return getLocalValue(STORAGE_KEY, [], normalizeCandidates);
}

function writeCandidates(list: MemoryCandidate[]): Promise<void> {
  return setLocalValue(STORAGE_KEY, list);
}

function normalizeCandidates(raw: unknown): MemoryCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is MemoryCandidate => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as MemoryCandidate;
    return typeof candidate.id === 'string' && typeof candidate.content === 'string';
  });
}
