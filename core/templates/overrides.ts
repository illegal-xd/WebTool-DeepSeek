/**
 * 模板覆盖 — 用户自定义提示词模板
 *
 * 模板键白名单（与 prompts.ts 导出的常量对应）。用户可通过 sidepanel
 * 「注入 -> 模板编辑器」覆盖这些模板文本；为空对象时走默认（编译期）模板。
 */
import { getLocalValue, setLocalValue } from '../storage/chrome';

export type TemplateKey =
  | 'SYSTEM_TEMPLATE_CHAT'
  | 'SYSTEM_TEMPLATE_THINKING'
  | 'USER_INPUT_PREFIX'
  | 'MEMORY_BACKGROUND_TEMPLATE'
  | 'TOOLS_SECTION_HEADING'
  | 'TOOL_INTRO_LINE'
  | 'TOOL_SCHEMAS_HEADING'
  | 'TOOL_MUST_FOLLOW_LINE'
  | 'TOOL_SCHEMA_TEMPLATE'
  | 'TOOL_FORMAT_REMINDER_TEMPLATE'
  | 'INSTRUCTION_SEPARATOR';

export type TemplateOverrides = Partial<Record<TemplateKey, string>>;

export const TEMPLATE_KEYS: TemplateKey[] = [
  'SYSTEM_TEMPLATE_CHAT',
  'SYSTEM_TEMPLATE_THINKING',
  'USER_INPUT_PREFIX',
  'MEMORY_BACKGROUND_TEMPLATE',
  'TOOLS_SECTION_HEADING',
  'TOOL_INTRO_LINE',
  'TOOL_SCHEMAS_HEADING',
  'TOOL_MUST_FOLLOW_LINE',
  'TOOL_SCHEMA_TEMPLATE',
  'TOOL_FORMAT_REMINDER_TEMPLATE',
  'INSTRUCTION_SEPARATOR',
];

export const TEMPLATE_KEY_LABELS: Record<TemplateKey, string> = {
  SYSTEM_TEMPLATE_CHAT: '系统模板（普通模式）',
  SYSTEM_TEMPLATE_THINKING: '系统模板（思考模式）',
  USER_INPUT_PREFIX: '用户输入包装前缀（已弃用——用户输入现直接原样输出，不再包装）',
  MEMORY_BACKGROUND_TEMPLATE: '记忆背景包装（#记忆名）',
  TOOLS_SECTION_HEADING: '工具区标题',
  TOOL_INTRO_LINE: '工具说明导语',
  TOOL_SCHEMAS_HEADING: '工具 Schema 区标题',
  TOOL_MUST_FOLLOW_LINE: '工具调用约束',
  TOOL_SCHEMA_TEMPLATE: '工具 Schema 渲染模板',
  TOOL_FORMAT_REMINDER_TEMPLATE: '工具格式提醒',
  INSTRUCTION_SEPARATOR: '指令块分隔符',
};

const STORAGE_KEY = 'webtool_deepseek_template_overrides';

export async function getTemplateOverrides(): Promise<TemplateOverrides> {
  return getLocalValue(STORAGE_KEY, {}, normalizeOverrides);
}

export async function saveTemplateOverrides(overrides: TemplateOverrides): Promise<void> {
  await setLocalValue(STORAGE_KEY, normalizeOverrides(overrides));
}

export async function resetTemplateOverrides(): Promise<void> {
  await saveTemplateOverrides({});
}

function normalizeOverrides(raw: unknown): TemplateOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: TemplateOverrides = {};
  for (const key of TEMPLATE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}
