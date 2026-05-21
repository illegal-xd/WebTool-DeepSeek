import type { Memory, MemoryScope, Skill, SystemPromptPreset, UsageStats } from './types';

export const DEFAULT_USAGE_STATS: UsageStats = {
  useCount: 0,
  lastUsedAt: null,
};

const MEMORY_SCOPE_BASE: Record<MemoryScope, number> = {
  permanent: 300,
  contextual: 180,
  temporary: 80,
};

export function normalizeUsageStats(usage?: Partial<UsageStats>): UsageStats {
  return {
    useCount: Number.isFinite(usage?.useCount) ? Math.max(0, usage!.useCount!) : 0,
    lastUsedAt: typeof usage?.lastUsedAt === 'number' ? usage.lastUsedAt : null,
    createdAt: typeof usage?.createdAt === 'number' ? usage.createdAt : undefined,
    updatedAt: typeof usage?.updatedAt === 'number' ? usage.updatedAt : undefined,
  };
}

export function defaultMemoryScope(memory: Pick<Memory, 'type' | 'pinned'>): MemoryScope {
  if (memory.type === 'user' || memory.type === 'feedback') return 'permanent';
  return 'contextual';
}

export function normalizeMemoryScope(memory: Pick<Memory, 'type' | 'pinned'> & { scope?: MemoryScope }): MemoryScope {
  if (memory.scope === 'permanent' || memory.scope === 'contextual' || memory.scope === 'temporary') {
    return memory.scope;
  }
  return defaultMemoryScope(memory);
}

export function usageCountScore(useCount: number): number {
  return Math.min(100, Math.log1p(Math.max(0, useCount)) * 25);
}

export function usageRecencyScore(lastUsedAt: number | null, now = Date.now()): number {
  if (!lastUsedAt) return 0;
  const days = Math.max(0, (now - lastUsedAt) / 86_400_000);
  return Math.max(0, 80 - days * 4);
}

export function memoryUsageScore(accessCount: number): number {
  return Math.min(80, Math.log1p(Math.max(0, accessCount)) * 18);
}

export function memoryRecencyScore(lastAccessedAt: number, now = Date.now()): number {
  const days = Math.max(0, (now - lastAccessedAt) / 86_400_000);
  return Math.max(0, 60 - days * 2);
}

export function memoryWeight(memory: Memory, keywordScore = 0, now = Date.now()): number {
  const scope = normalizeMemoryScope(memory);
  const expiresPenalty = memory.expiresAt && memory.expiresAt < now ? 500 : 0;
  return (
    MEMORY_SCOPE_BASE[scope] +
    (memory.pinned ? 1000 : 0) +
    memoryUsageScore(memory.accessCount) +
    memoryRecencyScore(memory.lastAccessedAt, now) +
    keywordScore -
    expiresPenalty
  );
}

export function queryMatchScore(name: string, description: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 600;
  if (n.includes(q)) return 300;
  if (d.includes(q)) return 120;
  return 0;
}

export function skillWeight(skill: Skill, query = '', now = Date.now()): number {
  const usage = normalizeUsageStats(skill.usage);
  const base = skill.source === 'custom' ? 120 : 100;
  return (
    base +
    usageCountScore(usage.useCount) +
    usageRecencyScore(usage.lastUsedAt, now) +
    queryMatchScore(skill.name, skill.description, query)
  );
}

export function presetWeight(preset: SystemPromptPreset, query = '', now = Date.now()): number {
  const usage = normalizeUsageStats(preset.usage);
  return (
    120 +
    usageCountScore(usage.useCount) +
    usageRecencyScore(usage.lastUsedAt, now) +
    queryMatchScore(preset.name, preset.content, query)
  );
}

function compareByUsageThenName(
  a: { name: string; usage?: Partial<UsageStats> },
  b: { name: string; usage?: Partial<UsageStats> },
): number {
  const au = normalizeUsageStats(a.usage);
  const bu = normalizeUsageStats(b.usage);
  return (
    (bu.lastUsedAt ?? 0) - (au.lastUsedAt ?? 0) ||
    bu.useCount - au.useCount ||
    a.name.localeCompare(b.name)
  );
}

export function sortSkillsByWeight(skills: Skill[], query = '', now = Date.now()): Skill[] {
  return [...skills].sort((a, b) => (
    skillWeight(b, query, now) - skillWeight(a, query, now) ||
    compareByUsageThenName(a, b)
  ));
}

export function sortPresetsByWeight(presets: SystemPromptPreset[], query = '', now = Date.now()): SystemPromptPreset[] {
  return [...presets].sort((a, b) => (
    presetWeight(b, query, now) - presetWeight(a, query, now) ||
    compareByUsageThenName(a, b)
  ));
}
