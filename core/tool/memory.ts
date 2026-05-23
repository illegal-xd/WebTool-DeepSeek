import type { Memory, MemoryType, MemoryScope, NewMemory } from '../types';
import type { JsonValue, ToolCall, ToolDescriptor, ToolProviderIdentity, ToolResult } from './types';

const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'topic', 'reference'];
const MEMORY_SCOPES: MemoryScope[] = ['permanent', 'contextual', 'temporary'];

export const MEMORY_TOOL_PROVIDER: ToolProviderIdentity = {
  kind: 'local',
  id: 'memory',
  displayName: 'WebTool Memory',
  transport: 'in_process',
};

export const MEMORY_TOOL_NAMES = ['memory_save', 'memory_update', 'memory_delete'] as const;
export type MemoryToolName = typeof MEMORY_TOOL_NAMES[number];

export interface MemoryToolRuntime {
  saveMemory(input: NewMemory): Promise<{ id: number } | null>;
  getMemoryById(id: number): Promise<Memory | null>;
  updateMemory(memory: Memory): Promise<void>;
  deleteMemory(id: number): Promise<void>;
}

export const MEMORY_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    id: 'local:memory:memory_save',
    provider: MEMORY_TOOL_PROVIDER,
    name: 'memory_save',
    invocationName: 'memory_save',
    title: '保存记忆',
    description: '保存一条新的长期记忆或上下文记忆',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: MEMORY_TYPES, description: '记忆类型：user/feedback/topic/reference' },
        scope: { type: 'string', enum: MEMORY_SCOPES, description: '记忆层级：permanent/contextual/temporary' },
        name: { type: 'string', description: '简短标题' },
        content: { type: 'string', description: '要保存的内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      },
      required: ['type', 'name', 'content', 'tags'],
      additionalProperties: false,
    },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  },
  {
    id: 'local:memory:memory_update',
    provider: MEMORY_TOOL_PROVIDER,
    name: 'memory_update',
    invocationName: 'memory_update',
    title: '更新记忆',
    description: '更新已有记忆',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '记忆 ID' },
        type: { type: 'string', enum: MEMORY_TYPES, description: '记忆类型' },
        scope: { type: 'string', enum: MEMORY_SCOPES, description: '记忆层级' },
        name: { type: 'string', description: '更新后的标题' },
        content: { type: 'string', description: '更新后的内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      },
      required: ['id', 'type', 'name', 'content', 'tags'],
      additionalProperties: false,
    },
    execution: { mode: 'auto', enabled: true, risk: 'medium' },
  },
  {
    id: 'local:memory:memory_delete',
    provider: MEMORY_TOOL_PROVIDER,
    name: 'memory_delete',
    invocationName: 'memory_delete',
    title: '删除记忆',
    description: '删除指定记忆',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '记忆 ID' } },
      required: ['id'],
      additionalProperties: false,
    },
    execution: { mode: 'auto', enabled: true, risk: 'medium' },
  },
];

export function isMemoryToolName(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeMemoryToolCall(runtime: MemoryToolRuntime, call: ToolCall): Promise<ToolResult> {
  if (call.name === 'memory_save') return saveMemory(runtime, call);
  if (call.name === 'memory_update') return updateExistingMemory(runtime, call);
  if (call.name === 'memory_delete') return deleteExistingMemory(runtime, call);
  return failure(call, 'memory_tool_unsupported', '不支持的记忆工具', `Unsupported memory tool: ${call.name}`, false);
}

async function saveMemory(runtime: MemoryToolRuntime, call: ToolCall): Promise<ToolResult> {
  const payload = call.payload;
  const name = stringValue(payload.name) || 'unnamed';
  const saved = await runtime.saveMemory({
    type: memoryTypeValue(payload.type) || 'topic',
    scope: memoryScopeValue(payload.scope) || 'contextual',
    name,
    content: stringValue(payload.content),
    description: name,
    tags: stringArrayValue(payload.tags),
    pinned: false,
  });
  if (!saved?.id) return failure(call, 'memory_save_failed', '保存失败', '未收到保存确认', true);
  return success(call, '已保存', name, { id: saved.id });
}

async function updateExistingMemory(runtime: MemoryToolRuntime, call: ToolCall): Promise<ToolResult> {
  const id = numberValue(call.payload.id);
  if (!id) return failure(call, 'memory_invalid_id', '无效 ID', undefined, false);
  const existing = await runtime.getMemoryById(id);
  if (!existing) return failure(call, 'memory_not_found', '未找到记忆', `ID ${id} 不存在`, false);
  const name = stringValue(call.payload.name) || existing.name;
  await runtime.updateMemory({
    ...existing,
    type: memoryTypeValue(call.payload.type) || existing.type,
    scope: memoryScopeValue(call.payload.scope) || existing.scope,
    name,
    content: stringValue(call.payload.content) || existing.content,
    description: name || existing.description,
    tags: Array.isArray(call.payload.tags) ? stringArrayValue(call.payload.tags) : existing.tags,
  });
  return success(call, '已更新', name);
}

async function deleteExistingMemory(runtime: MemoryToolRuntime, call: ToolCall): Promise<ToolResult> {
  const id = numberValue(call.payload.id);
  if (!id) return failure(call, 'memory_invalid_id', '无效 ID', undefined, false);
  await runtime.deleteMemory(id);
  return success(call, '已删除', `#${id}`);
}

function success(call: ToolCall, summary: string, detail?: string, output?: JsonValue): ToolResult {
  return { ok: true, name: call.name, callId: call.id, descriptorId: call.descriptorId, provider: call.provider ?? MEMORY_TOOL_PROVIDER, summary, detail, output };
}

function failure(call: ToolCall, code: string, summary: string, detail: string | undefined, retryable: boolean): ToolResult {
  return { ok: false, name: call.name, callId: call.id, descriptorId: call.descriptorId, provider: call.provider ?? MEMORY_TOOL_PROVIDER, summary, detail, error: { code, message: detail ?? summary, retryable } };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function memoryTypeValue(value: unknown): MemoryType | null {
  return typeof value === 'string' && MEMORY_TYPES.includes(value as MemoryType) ? value as MemoryType : null;
}

function memoryScopeValue(value: unknown): MemoryScope | null {
  return typeof value === 'string' && MEMORY_SCOPES.includes(value as MemoryScope) ? value as MemoryScope : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
