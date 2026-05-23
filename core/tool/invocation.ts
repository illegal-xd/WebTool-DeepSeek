import { MEMORY_TOOL_DESCRIPTORS, MEMORY_TOOL_NAMES } from './memory';
import type { ToolCall, ToolDescriptor, ToolPayload } from './types';

export const DEFAULT_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = MEMORY_TOOL_DESCRIPTORS;
export const DEFAULT_RECOGNIZED_TOOL_TAGS: readonly string[] = MEMORY_TOOL_NAMES;

export interface ToolInvocationCatalog {
  descriptors: readonly ToolDescriptor[];
  invocationNames: string[];
  descriptorByInvocationName: Map<string, ToolDescriptor>;
  descriptorByName: Map<string, ToolDescriptor>;
}

export interface ToolParsingInput {
  descriptors?: readonly ToolDescriptor[];
  recognizedTags?: readonly string[];
}

export function createToolInvocationCatalog(
  descriptors: readonly ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS,
  recognizedTags: readonly string[] = DEFAULT_RECOGNIZED_TOOL_TAGS,
): ToolInvocationCatalog {
  const descriptorByInvocationName = new Map<string, ToolDescriptor>();
  const descriptorByName = new Map<string, ToolDescriptor>();
  const invocationNames = new Set(recognizedTags.map((tag) => tag.trim()).filter(Boolean));
  for (const descriptor of descriptors) {
    const invocationName = descriptor.invocationName.trim();
    if (invocationName) {
      invocationNames.add(invocationName);
      if (!descriptorByInvocationName.has(invocationName)) descriptorByInvocationName.set(invocationName, descriptor);
    }
    const name = descriptor.name.trim();
    if (name && !descriptorByName.has(name)) descriptorByName.set(name, descriptor);
  }
  return { descriptors, invocationNames: [...invocationNames], descriptorByInvocationName, descriptorByName };
}

export function createXmlToolCallRegex(catalog: ToolInvocationCatalog): RegExp {
  if (catalog.invocationNames.length === 0) return /$a/g;
  const names = catalog.invocationNames.map(escapeRegExp).join('|');
  return new RegExp(`<(${names})>\\s*([\\s\\S]*?)\\s*<\\/\\1>`, 'g');
}

export function createToolCallFromInvocation(invocationName: string, payload: ToolPayload, raw: string, catalog: ToolInvocationCatalog): ToolCall {
  const descriptor = catalog.descriptorByInvocationName.get(invocationName) || catalog.descriptorByName.get(invocationName);
  return { name: descriptor?.name ?? invocationName, invocationName: descriptor?.invocationName ?? invocationName, payload, raw, descriptorId: descriptor?.id, provider: descriptor?.provider };
}

export function getToolOpenTag(invocationName: string): string {
  return `<${invocationName}>`;
}

export function getToolCloseTag(invocationName: string): string {
  return `</${invocationName}>`;
}

export function hasXmlToolMarker(text: string, catalog: ToolInvocationCatalog): boolean {
  return catalog.invocationNames.some((name) => text.includes(getToolOpenTag(name)) || text.includes(getToolCloseTag(name)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
