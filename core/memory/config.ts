import { getLocalValue, setLocalValue } from '../storage/chrome';
import { SYSTEM_TEMPLATE_CHAT } from '../templates';

const STORAGE_KEY = 'webtool_deepseek_memory_config';

export const DEFAULT_CUSTOM_MEMORY_PROMPT = SYSTEM_TEMPLATE_CHAT.trim();

export interface MemoryConfig {
  tokenBudget: number;
  singleMemoryInjection: boolean;
  customMemoryEnabled: boolean;
  customMemoryPrompt: string;
}

const DEFAULT_CONFIG: MemoryConfig = {
  tokenBudget: 3000,
  singleMemoryInjection: false,
  customMemoryEnabled: false,
  customMemoryPrompt: DEFAULT_CUSTOM_MEMORY_PROMPT,
};

export async function getMemoryConfig(): Promise<MemoryConfig> {
  return getLocalValue(STORAGE_KEY, { ...DEFAULT_CONFIG }, normalizeMemoryConfig);
}

export async function saveMemoryConfig(config: MemoryConfig): Promise<void> {
  await setLocalValue(STORAGE_KEY, {
    tokenBudget: config.tokenBudget,
    singleMemoryInjection: config.singleMemoryInjection === true,
    customMemoryEnabled: config.customMemoryEnabled === true,
    customMemoryPrompt: normalizeCustomMemoryPrompt(config.customMemoryPrompt),
  });
}

export function normalizeMemoryConfig(raw: unknown): MemoryConfig {
  if (raw && typeof raw === 'object') {
    const config = raw as Partial<MemoryConfig>;
    return {
      tokenBudget: typeof config.tokenBudget === 'number' && config.tokenBudget > 0 ? config.tokenBudget : DEFAULT_CONFIG.tokenBudget,
      singleMemoryInjection: config.singleMemoryInjection === true,
      customMemoryEnabled: config.customMemoryEnabled === true,
      customMemoryPrompt: normalizeCustomMemoryPrompt(config.customMemoryPrompt),
    };
  }
  return { ...DEFAULT_CONFIG };
}

export function getDefaultMemoryBudget(): number {
  return DEFAULT_CONFIG.tokenBudget;
}

function normalizeCustomMemoryPrompt(prompt: unknown): string {
  if (typeof prompt !== 'string') return DEFAULT_CONFIG.customMemoryPrompt;
  return prompt.trim().length > 0 ? prompt : DEFAULT_CONFIG.customMemoryPrompt;
}
