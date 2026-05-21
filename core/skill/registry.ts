import type { Skill } from '../types';
import { normalizeUsageStats } from '../weighting';
import { BUILTIN_SKILLS } from './builtin';

const STORAGE_KEY = 'deepseek_pp_skills';

function normalizeSkill(skill: Skill): Skill {
  return {
    ...skill,
    usage: normalizeUsageStats(skill.usage),
  };
}

export async function getAllSkills(): Promise<Skill[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
  const stored = data[STORAGE_KEY];
  const items = Array.isArray(stored) ? (stored as Skill[]) : [];
  const custom: Skill[] = items.filter(
    (s: Skill) => s.source === 'custom',
  );
  return [...BUILTIN_SKILLS.map(normalizeSkill), ...custom.map(normalizeSkill)];
}

export async function saveSkill(skill: Skill): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
  const stored = data[STORAGE_KEY];
  const custom: Skill[] = Array.isArray(stored)
    ? (stored as Skill[]).filter((s) => s.source === 'custom')
    : [];
  const idx = custom.findIndex((s) => s.name === skill.name);
  if (idx >= 0) {
    custom[idx] = normalizeSkill({ ...custom[idx], ...skill });
  } else {
    custom.push(normalizeSkill({ ...skill, source: 'custom' }));
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: custom });
}

export async function touchSkill(name: string): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
  const stored = data[STORAGE_KEY];
  const custom: Skill[] = Array.isArray(stored) ? (stored as Skill[]) : [];
  const idx = custom.findIndex((s) => s.name === name);
  if (idx === -1) return;

  const now = Date.now();
  const usage = normalizeUsageStats(custom[idx].usage);
  custom[idx] = {
    ...custom[idx],
    usage: {
      ...usage,
      useCount: usage.useCount + 1,
      lastUsedAt: now,
      updatedAt: now,
    },
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: custom });
}

export async function deleteSkill(name: string): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
  const stored = data[STORAGE_KEY];
  const custom: Skill[] = Array.isArray(stored)
    ? (stored as Skill[]).filter((s) => s.name !== name)
    : [];
  await chrome.storage.local.set({ [STORAGE_KEY]: custom });
}

export async function replaceAllCustomSkills(skills: Skill[]): Promise<void> {
  const custom = skills.map((s) => normalizeSkill({ ...s, source: 'custom' as const }));
  await chrome.storage.local.set({ [STORAGE_KEY]: custom });
}
