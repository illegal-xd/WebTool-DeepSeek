import { getLocalValue, setLocalValue } from '../storage/chrome';
import type { SystemPromptPreset } from '../types';
import { normalizeUsageStats } from '../weighting';

const STORAGE_KEY = 'deepseek_pp_presets';

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

export async function deletePreset(id: string): Promise<void> {
  const presets = await readPresets();
  const filtered = presets.filter((p) => p.id !== id);
  await writePresets(filtered);
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
