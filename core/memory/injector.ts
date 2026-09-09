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
  USER_INPUT_PREFIX,
} from '../templates';
import { DEFAULT_TOOL_DESCRIPTORS } from '../tool';
import type { Memory, ToolDescriptor } from '../types';
import { estimateTokens, formatMemoriesBlock, getMemoryBudget, selectMemories } from './selector';

export interface AugmentOptions {
  thinkingEnabled?: boolean;
  identityOnly?: boolean;
  toolDescriptors?: readonly ToolDescriptor[];
  tokenBudget?: number;
  instructionBlock?: string;
}

export interface CustomMemoryPromptOptions {
  toolDescriptors?: readonly ToolDescriptor[];
}

export function buildAugmentedPrompt(
  originalPrompt: string,
  allMemories: Memory[],
  options?: AugmentOptions,
): { augmented: string; usedMemoryIds: number[] } {
  const { thinkingEnabled = false, identityOnly = false, toolDescriptors = DEFAULT_TOOL_DESCRIPTORS, tokenBudget, instructionBlock } = options ?? {};

  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens, tokenBudget);

  const selected = selectMemories(originalPrompt, allMemories, { budget, identityOnly });
  const memBlock = formatMemoriesBlock(selected);

  const template = thinkingEnabled ? SYSTEM_TEMPLATE_THINKING : SYSTEM_TEMPLATE_CHAT;
  const system = fillTemplate(template, { memories: memBlock, tools: renderToolSchemas(toolDescriptors) });

  return {
    augmented: system + (instructionBlock ? instructionBlock + INSTRUCTION_SEPARATOR : '') + renderUserInputBlock(originalPrompt) + renderToolFormatReminder(toolDescriptors),
    usedMemoryIds: selected.map((m) => m.id!).filter(Boolean),
  };
}

export function buildInstructionOnlyPrompt(
  originalPrompt: string,
  instructionBlock: string,
): { augmented: string; usedMemoryIds: number[] } {
  return {
    augmented: instructionBlock ? instructionBlock + INSTRUCTION_SEPARATOR + renderUserInputBlock(originalPrompt) : originalPrompt,
    usedMemoryIds: [],
  };
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
  const instruction = [hydratedInstructionBlock, toolInstruction].filter(Boolean).join(INSTRUCTION_SEPARATOR);

  return {
    augmented: instruction
      ? instruction + INSTRUCTION_SEPARATOR + renderUserInputBlock(originalPrompt) + renderToolFormatReminder(toolDescriptors)
      : originalPrompt,
    usedMemoryIds: [],
  };
}

export function filterCustomMemoryToolDescriptors(descriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
  return descriptors.filter((descriptor) => !(descriptor.provider.kind === 'local' && descriptor.provider.id === 'memory'));
}

export function renderUserInputBlock(input: string): string {
  return `${USER_INPUT_PREFIX}${input}`;
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
    .replace(/\{\{tools\}\}/g, renderToolSchemas(descriptors));
}

function renderCustomToolInstruction(descriptors: readonly ToolDescriptor[]): string {
  if (descriptors.length === 0) return '';
  return [
    TOOLS_SECTION_HEADING,
    TOOL_INTRO_LINE,
    TOOL_SCHEMAS_HEADING,
    renderToolSchemas(descriptors),
    TOOL_MUST_FOLLOW_LINE,
  ].join('\n\n');
}

function renderToolSchema(descriptor: ToolDescriptor): string {
  const examplePayload = createExamplePayload(descriptor);
  return fillTemplate(TOOL_SCHEMA_TEMPLATE, {
    invocationName: descriptor.invocationName,
    title: descriptor.title,
    description: descriptor.description,
    examplePayload: JSON.stringify(examplePayload, null, 2),
    inputSchema: JSON.stringify(descriptor.inputSchema),
  });
}

function renderToolFormatReminder(descriptors: readonly ToolDescriptor[]): string {
  const names = descriptors.map((descriptor) => descriptor.invocationName).filter(Boolean);
  if (names.length === 0) return '';
  return fillTemplate(TOOL_FORMAT_REMINDER_TEMPLATE, { names: names.join(', ') });
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
