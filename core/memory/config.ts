const STORAGE_KEY = 'webtool_deepseek_memory_config';

export interface MemoryConfig {
  tokenBudget: number;
  singleMemoryInjection: boolean;
}

const DEFAULT_CONFIG: MemoryConfig = {
  tokenBudget: 3000,
  singleMemoryInjection: false,
};

export async function getMemoryConfig(): Promise<MemoryConfig> {
  const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
  const raw = data[STORAGE_KEY];
  if (raw && typeof raw === 'object') {
    const config = raw as Partial<MemoryConfig>;
    return {
      tokenBudget: typeof config.tokenBudget === 'number' && config.tokenBudget > 0 ? config.tokenBudget : DEFAULT_CONFIG.tokenBudget,
      singleMemoryInjection: config.singleMemoryInjection === true,
    };
  }
  return { ...DEFAULT_CONFIG };
}

export async function saveMemoryConfig(config: MemoryConfig): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      tokenBudget: config.tokenBudget,
      singleMemoryInjection: config.singleMemoryInjection === true,
    },
  });
}

export function getDefaultMemoryBudget(): number {
  return DEFAULT_CONFIG.tokenBudget;
}