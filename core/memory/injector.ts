import {
  INSTRUCTION_SEPARATOR,
  SYSTEM_TEMPLATE_CHAT,
  SYSTEM_TEMPLATE_THINKING,
  TOOL_FORMAT_REMINDER_TEMPLATE,
  TOOL_INTRO_LINE,
  TOOL_MUST_FOLLOW_LINE,
  TOOL_SCHEMA_TEMPLATE,
  TOOL_SCHEMAS_HEADING,
  TOOLS_SECTION_HEADING,
} from '../templates';
import type { TemplateOverrides } from '../templates/overrides';
import { DEFAULT_TOOL_DESCRIPTORS, MEMORY_TOOL_NAMES, type MemoryToolName } from '../tool';
import type { Memory, ToolDescriptor } from '../types';
import { estimateTokens, formatMemoriesBlock, getMemoryBudget, selectMemories } from './selector';

/** 用户自定义模板（注入路径内存态，随 state 更新；为空时走默认模板）。 */
let activeTemplateOverrides: TemplateOverrides = {};

/** 更新注入路径使用的模板覆盖（由 fetch-hook 状态同步调用）。 */
export function setTemplateOverrides(overrides: TemplateOverrides | null | undefined): void {
  activeTemplateOverrides = overrides ?? {};
}

/** 按模板名取模板：优先用户覆盖，否则默认值。 */
function tpl(name: keyof TemplateOverrides, fallback: string): string {
  const overridden = activeTemplateOverrides[name];
  return typeof overridden === 'string' && overridden.length > 0 ? overridden : fallback;
}

/** 供外部（如 fetch-hook 的记忆背景包装）按名解析覆盖模板。 */
export function resolveTemplate(name: keyof TemplateOverrides, fallback: string): string {
  return tpl(name, fallback);
}

export interface AugmentOptions {
  thinkingEnabled?: boolean;
  identityOnly?: boolean;
  toolDescriptors?: readonly ToolDescriptor[];
  tokenBudget?: number;
  instructionBlock?: string;
  /** 预设名称 → 与预设高度重合的记忆 id 列表（用于给相关记忆行加关联标注）。 */
  presetRelatedMemoryIds?: Record<string, number[]>;
}

export interface CustomMemoryPromptOptions {
  toolDescriptors?: readonly ToolDescriptor[];
}

interface LightweightMemoryPromptOptions {
  instructionBlock?: string;
  tokenBudget?: number;
  excludeMemoryIds?: Set<number>;
  toolDescriptors?: readonly ToolDescriptor[];
}

export function buildAugmentedPrompt(
  originalPrompt: string,
  allMemories: Memory[],
  options?: AugmentOptions,
): { augmented: string; usedMemoryIds: number[] } {
  const { thinkingEnabled = false, identityOnly = false, toolDescriptors = DEFAULT_TOOL_DESCRIPTORS, tokenBudget, instructionBlock, presetRelatedMemoryIds } = options ?? {};

  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens, tokenBudget);

  const selected = selectMemories(originalPrompt, allMemories, { budget, identityOnly });
  const memBlock = formatMemoriesBlock(selected);
  const relatedBlock = renderPresetRelatedBlock(selected, presetRelatedMemoryIds);

  const systemTemplate = thinkingEnabled
    ? tpl('SYSTEM_TEMPLATE_THINKING', SYSTEM_TEMPLATE_THINKING)
    : tpl('SYSTEM_TEMPLATE_CHAT', SYSTEM_TEMPLATE_CHAT);
  const system = fillTemplate(
    stripEmptyMemoryContext(systemTemplate, memBlock),
    {
      memories: memBlock,
      memoryContext: renderMemoryContext(memBlock),
      tools: renderToolSchemas(toolDescriptors),
    },
  );

  const sep = tpl('INSTRUCTION_SEPARATOR', INSTRUCTION_SEPARATOR);
  const userInput = renderUserInputBlock(originalPrompt);

  return {
    augmented: system
      + (relatedBlock ? relatedBlock + sep : '')
      + (instructionBlock ? instructionBlock + sep : '')
      + sep
      + userInput
      + renderToolFormatReminder(toolDescriptors),
    usedMemoryIds: selected.map((m) => m.id!).filter(Boolean),
  };
}

/** 渲染「与预设高度重合」的关联标注段（无重合时不输出）。 */
function renderPresetRelatedBlock(memories: Memory[], presetRelatedMemoryIds?: Record<string, number[]>): string {
  if (!presetRelatedMemoryIds) return '';
  const lines: string[] = [];
  for (const [presetName, ids] of Object.entries(presetRelatedMemoryIds)) {
    if (ids.length === 0) continue;
    const linked = memories.filter((m) => m.id != null && ids.includes(m.id));
    if (linked.length === 0) continue;
    lines.push(`## 预设关联\n以下记忆与你当前启用的预设「${presetName}」高度重合，回答时请结合该预设的指令：\n${linked.map((m) => `- ${m.name}`).join('\n')}`);
  }
  return lines.join('\n');
}

function renderMemoryContext(memories: string): string {
  if (!memories) return '';
  return `## 补充上下文\n\n为了帮助回答用户的问题，以下是相关的背景信息：\n\n### 已知信息\n${memories}`;
}

/** 兼容旧版/自定义模板：空记忆时移除包裹 {{memories}} 的上下文标题段。 */
function stripEmptyMemoryContext(template: string, memories: string): string {
  if (memories || !template.includes('{{memories}}')) return template;
  return template
    .replace(/## 补充上下文\s*(?:为了帮助回答用户的问题，以下是相关的背景信息：\s*)?### 已知信息\s*\{\{memories\}\}\s*/g, '')
    .replace(/### 已知信息\s*\{\{memories\}\}\s*/g, '');
}

export function buildInstructionOnlyPrompt(
  originalPrompt: string,
  instructionBlock: string,
): { augmented: string; usedMemoryIds: number[] } {
  const sep = tpl('INSTRUCTION_SEPARATOR', INSTRUCTION_SEPARATOR);
  return {
    augmented: instructionBlock
      ? instructionBlock + sep + renderUserInputBlock(originalPrompt)
      : originalPrompt,
    usedMemoryIds: [],
  };
}

/**
 * 轻量记忆补充注入：不重复系统模板和完整工具集。
 * 用于同一对话后续轮次——补充本轮新选中的记忆，并保留读取其他记忆所需的
 * MCP 查询工具说明，避免预设的自动注入范围被误解为记忆库访问边界。
 */
export function buildLightweightMemoryPrompt(
  originalPrompt: string,
  memories: Memory[],
  options?: LightweightMemoryPromptOptions,
): { augmented: string; usedMemoryIds: number[] } {
  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens, options?.tokenBudget);
  const selected = selectMemories(originalPrompt, memories, { budget, identityOnly: false });
  const fresh = options?.excludeMemoryIds
    ? selected.filter((m) => m.id == null || !options.excludeMemoryIds!.has(m.id))
    : selected;
  const memBlock = formatMemoriesBlock(fresh);
  const memoryReaders = filterMemoryReadToolDescriptors(options?.toolDescriptors ?? []);

  const sep = tpl('INSTRUCTION_SEPARATOR', INSTRUCTION_SEPARATOR);
  const parts: string[] = [];
  if (memBlock) parts.push(`## 补充上下文\n\n### 已知信息\n${memBlock}`);
  if (options?.instructionBlock) parts.push(options.instructionBlock);
  if (memoryReaders.length > 0) parts.push(renderMemoryLookupInstruction(memoryReaders));
  parts.push(renderUserInputBlock(originalPrompt));
  return { augmented: parts.join(sep), usedMemoryIds: fresh.map((m) => m.id!).filter(Boolean) };
}

function filterMemoryReadToolDescriptors(descriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
  return descriptors.filter((descriptor) => {
    if (descriptor.provider.kind !== 'mcp' || descriptor.execution.enabled === false) return false;
    const tokens = `${descriptor.name} ${descriptor.invocationName}`.toLowerCase().split(/[^a-z0-9]+/);
    return tokens.includes('memory')
      && tokens.some((token) => ['list', 'search', 'get', 'read'].includes(token));
  });
}

function renderMemoryLookupInstruction(descriptors: readonly ToolDescriptor[]): string {
  return [
    '## 记忆查询说明',
    '当前预设选中的记忆仅限定自动注入范围，不限制访问记忆库中的其他记忆。',
    '当用户要求查看、查找或引用某条记忆时，请主动使用以下记忆查询工具确认，不要仅依据当前已注入的记忆作答。',
    renderToolSchemas(descriptors),
    renderToolFormatReminder(descriptors),
  ].filter(Boolean).join('\n\n');
}

export function buildCustomMemoryPrompt(
  originalPrompt: string,
  instructionBlock: string,
  options?: CustomMemoryPromptOptions,
): { augmented: string; usedMemoryIds: number[] } {
  const toolDescriptors = filterCustomMemoryToolDescriptors(options?.toolDescriptors ?? []);
  const promptHasToolPlaceholder = instructionBlock.includes('{{tools}}');
  const hydratedInstructionBlock = hydrateCustomMemoryInstruction(instructionBlock, toolDescriptors);
  const toolInstruction = promptHasToolPlaceholder ? '' : renderCustomToolInstruction(toolDescriptors);
  const instruction = [hydratedInstructionBlock, toolInstruction].filter(Boolean).join(tpl('INSTRUCTION_SEPARATOR', INSTRUCTION_SEPARATOR));

  const sep = tpl('INSTRUCTION_SEPARATOR', INSTRUCTION_SEPARATOR);
  return {
    augmented: instruction
      ? instruction + sep + renderUserInputBlock(originalPrompt) + renderToolFormatReminder(toolDescriptors)
      : originalPrompt,
    usedMemoryIds: [],
  };
}

export function filterCustomMemoryToolDescriptors(descriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
  return descriptors.filter((descriptor) => !(descriptor.provider.kind === 'local' && descriptor.provider.id === 'memory'));
}

/** 用户输入保持原样输出（不重述、不包装），避免干扰 DeepSeek 原生用户消息语义（如联网搜索触发）。 */
export function renderUserInputBlock(input: string): string {
  return input;
}

/** 按 descriptors 引用缓存渲染结果，避免同一请求内多次 JSON.stringify。 */
const toolSchemasCache = new WeakMap<readonly ToolDescriptor[], string>();
const EMPTY_DESCRIPTORS_CACHE = '';

export function renderToolSchemas(descriptors: readonly ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS): string {
  if (descriptors.length === 0) return EMPTY_DESCRIPTORS_CACHE;
  const cached = toolSchemasCache.get(descriptors);
  if (cached !== undefined) return cached;
  const rendered = descriptors.map(renderToolSchema).join('\n\n');
  toolSchemasCache.set(descriptors, rendered);
  return rendered;
}

function hydrateCustomMemoryInstruction(instructionBlock: string, descriptors: readonly ToolDescriptor[]): string {
  return instructionBlock
    .trim()
    .replace(/\{\{memories\}\}/g, '')
    .replace(/\{\{memoryContext\}\}/g, '')
    .replace(/\{\{tools\}\}/g, renderToolSchemas(descriptors));
}

function renderCustomToolInstruction(descriptors: readonly ToolDescriptor[]): string {
  if (descriptors.length === 0) return '';
  return [
    tpl('TOOLS_SECTION_HEADING', TOOLS_SECTION_HEADING),
    tpl('TOOL_INTRO_LINE', TOOL_INTRO_LINE),
    tpl('TOOL_SCHEMAS_HEADING', TOOL_SCHEMAS_HEADING),
    renderToolSchemas(descriptors),
    tpl('TOOL_MUST_FOLLOW_LINE', TOOL_MUST_FOLLOW_LINE),
  ].join('\n\n');
}

function renderToolSchema(descriptor: ToolDescriptor): string {
  const examplePayload = createExamplePayload(descriptor);
  return fillTemplate(tpl('TOOL_SCHEMA_TEMPLATE', TOOL_SCHEMA_TEMPLATE), {
    invocationName: descriptor.invocationName,
    title: descriptor.title,
    description: descriptor.description,
    examplePayload: JSON.stringify(examplePayload, null, 2),
    inputSchema: JSON.stringify(descriptor.inputSchema),
  });
}

function renderToolFormatReminder(descriptors: readonly ToolDescriptor[]): string {
  // 仅当存在非记忆工具（如 MCP）时附加简短格式提醒；纯记忆场景系统模板已内嵌说明，不重复。
  const externalNames = descriptors
    .map((descriptor) => descriptor.invocationName)
    .filter(Boolean)
    .filter((name) => !MEMORY_TOOL_NAMES.includes(name as MemoryToolName));
  if (externalNames.length === 0) return '';
  return fillTemplate(tpl('TOOL_FORMAT_REMINDER_TEMPLATE', TOOL_FORMAT_REMINDER_TEMPLATE), { names: externalNames.join(', ') });
}

/** 只替换模板中命名的 {{key}} 占位符；不匹配的占位符原样保留。 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

function createExamplePayload(descriptor: ToolDescriptor): Record<string, unknown> {
  const properties = descriptor.inputSchema.properties ?? {};
  const required = descriptor.inputSchema.required ?? Object.keys(properties);
  const payload: Record<string, unknown> = {};
  for (const key of required) payload[key] = exampleValue(properties[key]);
  return payload;
}

function exampleValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return 'value';
  const value = schema as Record<string, unknown>;
  const type = value.type;
  if (Array.isArray(type)) return exampleValue({ ...value, type: type[0] });
  if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'string':
    default:
      return 'value';
  }
}
