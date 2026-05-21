import type { ModelType } from '../types';

const STORAGE_KEY = 'deepseek_pp_model_type';

export async function getModelType(): Promise<ModelType> {
  const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
  const val = data[STORAGE_KEY];
  return val === 'expert' ? val : null;
}

export async function setModelType(modelType: ModelType): Promise<void> {
  if (modelType === null) {
    await chrome.storage.local.remove(STORAGE_KEY);
  } else {
    await chrome.storage.local.set({ [STORAGE_KEY]: modelType });
  }
}
