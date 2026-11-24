import { getLocalValue, setLocalValue } from '../storage/chrome';
import { SYSTEM_TEMPLATE_CHAT } from '../templates';
import { MEMORY_TOKEN_BUDGET } from '../constants';

const STORAGE_KEY = 'webtool_deepseek_memory_config';

export const DEFAULT_CUSTOM_MEMORY_PROMPT = SYSTEM_TEMPLATE_CHAT.trim();

export interface MemoryConfig {
  tokenBudget: number;
  singleMemoryInjection: boolean;
  customMemoryEnabled: boolean;
  customMemoryPrompt: string;
  /**
   * 输入框 `#` 记忆弹窗的默认勾选策略。
   * 默认 false：弹窗列出记忆但一条都不勾选，避免「打开即注入」。
   */
  popupDefaultSelectAll: boolean;
  /**
   * 工具执行后是否自动发送工具结果继续对话。
   * 默认 false：自动连发消息属于机器人式行为，需用户显式开启。
   */
  autoContinueEnabled: boolean;
}

const DEFAULT_CONFIG: MemoryConfig = {
  tokenBudget: MEMORY_TOKEN_BUDGET,
  singleMemoryInjection: false,
  customMemoryEnabled: false,
  customMemoryPrompt: DEFAULT_CUSTOM_MEMORY_PROMPT,
  popupDefaultSelectAll: false,
  autoContinueEnabled: false,
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
    popupDefaultSelectAll: config.popupDefaultSelectAll === true,
    autoContinueEnabled: config.autoContinueEnabled === true,
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
      popupDefaultSelectAll: config.popupDefaultSelectAll === true,
      autoContinueEnabled: config.autoContinueEnabled === true,
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
