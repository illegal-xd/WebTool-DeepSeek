import { getLocalValue, removeLocalValue, setLocalValue } from '../storage/chrome';
import type { SystemPromptPreset } from '../types';
import { normalizeUsageStats } from '../weighting';

const STORAGE_KEY = 'deepseek_pp_presets';
const ACTIVE_KEY = 'deepseek_pp_active_preset_id';

function normalizePreset(preset: SystemPromptPreset): SystemPromptPreset {
  return {
    ...preset,
    usage: normalizeUsageStats(preset.usage),
  };
}

export async function getAllPresets(): Promise<SystemPromptPreset[]> {
  return readPresets();
}

export async function savePreset(preset: SystemPromptPreset): Promise<void> {
  const presets = await readPresets();
  const idx = presets.findIndex((p) => p.id === preset.id);
  const nextPreset = normalizePreset(idx >= 0 ? { ...presets[idx], ...preset } : preset);
  if (idx >= 0) {
    presets[idx] = nextPreset;
  } else {
    presets.push(nextPreset);
  }
  await writePresets(presets);
}

export async function touchPreset(id: string): Promise<void> {
  const presets = await readPresets();
  const idx = presets.findIndex((p) => p.id === id);
  if (idx === -1) return;

  const now = Date.now();
  const usage = normalizeUsageStats(presets[idx].usage);
  presets[idx] = {
    ...presets[idx],
    usage: {
      ...usage,
      useCount: usage.useCount + 1,
      lastUsedAt: now,
      updatedAt: now,
    },
  };
  await writePresets(presets);
}

export async function deletePreset(id: string): Promise<void> {
  const presets = await readPresets();
  const filtered = presets.filter((p) => p.id !== id);
  await writePresets(filtered);

  const activeId = await getActivePresetId();
  if (activeId === id) {
    await setActivePresetId(null);
  }
}

export async function getActivePresetId(): Promise<string | null> {
  return getLocalValue(ACTIVE_KEY, null, normalizeActivePresetId);
}

export async function setActivePresetId(id: string | null): Promise<void> {
  if (id === null) {
    await removeLocalValue(ACTIVE_KEY);
  } else {
    await setLocalValue(ACTIVE_KEY, id);
  }
}

export async function getActivePreset(): Promise<SystemPromptPreset | null> {
  const activeId = await getActivePresetId();
  if (!activeId) return null;
  const presets = await readPresets();
  return presets.find((p) => p.id === activeId) ?? null;
}

export async function replaceAllPresets(presets: SystemPromptPreset[]): Promise<void> {
  await writePresets(presets);
}

function readPresets(): Promise<SystemPromptPreset[]> {
  return getLocalValue(STORAGE_KEY, [], normalizePresets);
}

function writePresets(presets: SystemPromptPreset[]): Promise<void> {
  return setLocalValue(STORAGE_KEY, presets.map(normalizePreset));
}

function normalizePresets(raw: unknown): SystemPromptPreset[] {
  return Array.isArray(raw) ? (raw as SystemPromptPreset[]).map(normalizePreset) : [];
}

function normalizeActivePresetId(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}
