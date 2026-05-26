import { getLocalValue, setLocalValue } from '../storage/chrome';

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
  return getLocalValue(STORAGE_KEY, { ...DEFAULT_CONFIG }, normalizeMemoryConfig);
}

export async function saveMemoryConfig(config: MemoryConfig): Promise<void> {
  await setLocalValue(STORAGE_KEY, {
    tokenBudget: config.tokenBudget,
    singleMemoryInjection: config.singleMemoryInjection === true,
  });
}

function normalizeMemoryConfig(raw: unknown): MemoryConfig {
  if (raw && typeof raw === 'object') {
    const config = raw as Partial<MemoryConfig>;
    return {
      tokenBudget: typeof config.tokenBudget === 'number' && config.tokenBudget > 0 ? config.tokenBudget : DEFAULT_CONFIG.tokenBudget,
      singleMemoryInjection: config.singleMemoryInjection === true,
    };
  }
  return { ...DEFAULT_CONFIG };
}

export function getDefaultMemoryBudget(): number {
  return DEFAULT_CONFIG.tokenBudget;
}