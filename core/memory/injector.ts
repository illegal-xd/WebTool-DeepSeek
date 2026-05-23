import { SYSTEM_TEMPLATE_CHAT, SYSTEM_TEMPLATE_THINKING } from '../constants';
import { DEFAULT_TOOL_DESCRIPTORS } from '../tool';
import type { Memory, ToolDescriptor } from '../types';
import { estimateTokens, formatMemoriesBlock, getMemoryBudget, selectMemories } from './selector';

export interface AugmentOptions {
  thinkingEnabled?: boolean;
  identityOnly?: boolean;
  toolDescriptors?: readonly ToolDescriptor[];
}

export function buildAugmentedPrompt(
  originalPrompt: string,
  allMemories: Memory[],
  options?: AugmentOptions,
): { augmented: string; usedMemoryIds: number[] } {
  const { thinkingEnabled = false, identityOnly = false, toolDescriptors = DEFAULT_TOOL_DESCRIPTORS } = options ?? {};

  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens);

  const selected = selectMemories(originalPrompt, allMemories, { budget, identityOnly });
  const memBlock = formatMemoriesBlock(selected);

  const template = thinkingEnabled ? SYSTEM_TEMPLATE_THINKING : SYSTEM_TEMPLATE_CHAT;
  const system = template
    .replace('{{memories}}', memBlock)
    .replace('{{tools}}', renderToolSchemas(toolDescriptors));

  return {
    augmented: system + originalPrompt + renderToolFormatReminder(toolDescriptors),
    usedMemoryIds: selected.map((m) => m.id!).filter(Boolean),
  };
}

export function renderToolSchemas(descriptors: readonly ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS): string {
  return descriptors.map(renderToolSchema).join('\n\n');
}

function renderToolSchema(descriptor: ToolDescriptor): string {
  const examplePayload = createExamplePayload(descriptor);
  return [
    `### Tool ${descriptor.invocationName}`,
    `Title: ${descriptor.title}`,
    `Description: ${descriptor.description}`,
    `Valid call format for ${descriptor.invocationName}:`,
    `<${descriptor.invocationName}>`,
    JSON.stringify(examplePayload, null, 2),
    `</${descriptor.invocationName}>`,
    `Invalid formats: <invoke name="${descriptor.invocationName}">...</invoke>, <tool_call>...</tool_call>`,
    `Parameters JSON Schema: ${JSON.stringify(descriptor.inputSchema)}`,
  ].join('\n');
}

function renderToolFormatReminder(descriptors: readonly ToolDescriptor[]): string {
  const names = descriptors.map((descriptor) => descriptor.invocationName).filter(Boolean);
  if (names.length === 0) return '';
  return [
    '',
    '',
    '---',
    'Tool call format reminder:',
    `Available tool tag names: ${names.join(', ')}`,
    'To call a tool, use ONLY the direct XML tag whose name is the tool name, with valid JSON as the body.',
    'Do not use <invoke name="...">, <tool_call>, Markdown code fences, or any wrapper format.',
  ].join('\n');
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
