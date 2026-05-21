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
  const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
  const items = data[STORAGE_KEY];
  return Array.isArray(items) ? (items as SystemPromptPreset[]).map(normalizePreset) : [];
}

export async function savePreset(preset: SystemPromptPreset): Promise<void> {
  const presets = await getAllPresets();
  const idx = presets.findIndex((p) => p.id === preset.id);
  const nextPreset = normalizePreset(idx >= 0 ? { ...presets[idx], ...preset } : preset);
  if (idx >= 0) {
    presets[idx] = nextPreset;
  } else {
    presets.push(nextPreset);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: presets });
}

export async function touchPreset(id: string): Promise<void> {
  const presets = await getAllPresets();
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
  await chrome.storage.local.set({ [STORAGE_KEY]: presets });
}

export async function deletePreset(id: string): Promise<void> {
  const presets = await getAllPresets();
  const filtered = presets.filter((p) => p.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });

  const activeId = await getActivePresetId();
  if (activeId === id) {
    await setActivePresetId(null);
  }
}

export async function getActivePresetId(): Promise<string | null> {
  const data = await chrome.storage.local.get(ACTIVE_KEY) as Record<string, unknown>;
  const val = data[ACTIVE_KEY];
  return typeof val === 'string' ? val : null;
}

export async function setActivePresetId(id: string | null): Promise<void> {
  if (id === null) {
    await chrome.storage.local.remove(ACTIVE_KEY);
  } else {
    await chrome.storage.local.set({ [ACTIVE_KEY]: id });
  }
}

export async function getActivePreset(): Promise<SystemPromptPreset | null> {
  const activeId = await getActivePresetId();
  if (!activeId) return null;
  const presets = await getAllPresets();
  return presets.find((p) => p.id === activeId) ?? null;
}

export async function replaceAllPresets(presets: SystemPromptPreset[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: presets.map(normalizePreset) });
}
