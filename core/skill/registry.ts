import { getLocalValue, setLocalValue } from '../storage/chrome';
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
  const custom = await readCustomSkills();
  return [...BUILTIN_SKILLS.map(normalizeSkill), ...custom.map(normalizeSkill)];
}

export async function saveSkill(skill: Skill): Promise<void> {
  const custom = await readCustomSkills();
  const idx = custom.findIndex((s) => s.name === skill.name);
  if (idx >= 0) {
    custom[idx] = normalizeSkill({ ...custom[idx], ...skill });
  } else {
    custom.push(normalizeSkill({ ...skill, source: 'custom' }));
  }
  await writeCustomSkills(custom);
}

export async function touchSkill(name: string): Promise<void> {
  const custom = await readCustomSkills();
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
  await writeCustomSkills(custom);
}

export async function deleteSkill(name: string): Promise<void> {
  const custom = (await readCustomSkills()).filter((s) => s.name !== name);
  await writeCustomSkills(custom);
}

export async function replaceAllCustomSkills(skills: Skill[]): Promise<void> {
  const custom = skills.map((s) => normalizeSkill({ ...s, source: 'custom' as const }));
  await writeCustomSkills(custom);
}

function readCustomSkills(): Promise<Skill[]> {
  return getLocalValue(STORAGE_KEY, [], normalizeCustomSkills);
}

function writeCustomSkills(skills: Skill[]): Promise<void> {
  return setLocalValue(STORAGE_KEY, skills.map(normalizeSkill));
}

function normalizeCustomSkills(raw: unknown): Skill[] {
  const items = Array.isArray(raw) ? raw as Skill[] : [];
  return items.filter((skill) => skill.source === 'custom').map(normalizeSkill);
}
