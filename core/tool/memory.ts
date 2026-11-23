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

export const MEMORY_TOOL_NAMES = ['memory_list', 'memory_get', 'memory_save', 'memory_update', 'memory_delete'] as const;
export type MemoryToolName = typeof MEMORY_TOOL_NAMES[number];

export interface MemoryToolRuntime {
  listMemories(): Promise<Memory[]>;
  saveMemory(input: NewMemory): Promise<{ id: number } | null>;
  getMemoryById(id: number): Promise<Memory | null>;
  updateMemory(memory: Memory): Promise<void>;
  deleteMemory(id: number): Promise<void>;
}

export const MEMORY_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    id: 'local:memory:memory_list',
    provider: MEMORY_TOOL_PROVIDER,
    name: 'memory_list',
    invocationName: 'memory_list',
    title: '列出记忆标题',
    description: '列出记忆库中的记忆标题（含 ID 与类型，不含正文）。可用 query 按标题/标签过滤，limit 限制条数（默认 50，上限 200）。只读，不修改记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：按标题或标签过滤' },
        limit: { type: 'integer', description: '可选：返回条数上限（默认 50）' },
      },
      required: [],
      additionalProperties: false,
    },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  },
  {
    id: 'local:memory:memory_get',
    provider: MEMORY_TOOL_PROVIDER,
    name: 'memory_get',
    invocationName: 'memory_get',
    title: '读取记忆全文',
    description: '读取单条记忆的完整正文、标签与元数据。参数 key 传记忆 ID（如 "89" 或 "#89"）或标题；标题支持唯一前缀匹配。只读，不修改记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '记忆 ID（如 "89"、"#89"）或标题' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  },
  {
    id: 'local:memory:memory_save',
    provider: MEMORY_TOOL_PROVIDER,
    name: 'memory_save',
    invocationName: 'memory_save',
    title: '保存记忆',
    description: '保存一条新的长期记忆或上下文记忆；保存后默认开启静默注入（后续对话自动带入）；若内容与当前启用的预设高度相关，请在 tags 中标注预设名或相关主题，便于后续注入时自动关联',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: MEMORY_TYPES, description: '记忆类型：user/feedback/topic/reference' },
        scope: { type: 'string', enum: MEMORY_SCOPES, description: '记忆层级：permanent/contextual/temporary' },
        name: { type: 'string', description: '简短标题' },
        content: { type: 'string', description: '要保存的内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可与预设名/主题一致，用于关联）' },
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
  if (call.name === 'memory_list') return listMemoryEntries(runtime, call);
  if (call.name === 'memory_get') return readMemoryEntry(runtime, call);
  if (call.name === 'memory_save') return saveMemory(runtime, call);
  if (call.name === 'memory_update') return updateExistingMemory(runtime, call);
  if (call.name === 'memory_delete') return deleteExistingMemory(runtime, call);
  return failure(call, 'memory_tool_unsupported', '不支持的记忆工具', `Unsupported memory tool: ${call.name}`, false);
}

const MEMORY_LIST_DEFAULT_LIMIT = 50;
const MEMORY_LIST_MAX_LIMIT = 200;

/** 列表行：只给 ID / 类型 / 标题（正文与标签走 memory_get）。 */
function formatListLine(memory: Memory): string {
  const id = memory.id != null ? `#${memory.id}` : '#?';
  return `- ${id} [${memory.type}] ${memory.name}`;
}

async function listMemoryEntries(runtime: MemoryToolRuntime, call: ToolCall): Promise<ToolResult> {
  const query = stringValue(call.payload.query).trim().toLowerCase();
  const requested = numberValue(call.payload.limit);
  const limit = Math.min(requested > 0 ? requested : MEMORY_LIST_DEFAULT_LIMIT, MEMORY_LIST_MAX_LIMIT);

  const all = await runtime.listMemories();
  const matched = query
    ? all.filter((memory) => memory.name.toLowerCase().includes(query)
      || memory.tags.some((tag) => tag.toLowerCase().includes(query)))
    : all;
  const rows = matched.slice(0, limit);

  if (rows.length === 0) {
    return success(call, query ? '没有匹配的记忆' : '记忆库为空', rows.length === 0 ? '' : undefined, { count: 0, items: [] });
  }
  const lines = rows.map(formatListLine).join('\n');
  const suffix = matched.length > rows.length ? `\n（共 ${matched.length} 条，已显示前 ${rows.length} 条）` : '';
  return success(
    call,
    `共 ${matched.length} 条记忆`,
    lines + suffix,
    { count: matched.length, items: rows.map((memory) => ({ id: memory.id ?? 0, type: memory.type, name: memory.name })) },
  );
}

function formatMemoryEntry(memory: Memory): string {
  const id = memory.id != null ? `#${memory.id}` : '#?';
  const silent = memory.silentInject === true ? '是' : '否';
  const lines = [
    `${id} [${memory.type}] ${memory.name}`,
    `层级：${memory.scope}｜静默注入：${silent}`,
    memory.tags.length > 0 ? `标签：${memory.tags.join('、')}` : '标签：无',
    '内容：',
    memory.content,
  ];
  return lines.join('\n');
}

async function readMemoryEntry(runtime: MemoryToolRuntime, call: ToolCall): Promise<ToolResult> {
  const key = stringValue(call.payload.key).trim();
  if (!key) return failure(call, 'memory_invalid_key', '缺少记忆标识', '参数 key 需要填写记忆 ID 或标题', false);

  const numeric = Number(key.replace(/^#/, ''));
  if (Number.isFinite(numeric) && numeric > 0) {
    const byId = await runtime.getMemoryById(numeric);
    if (byId) return memoryEntrySuccess(call, byId);
  }

  const all = await runtime.listMemories();
  const lower = key.toLowerCase();
  const exact = all.find((memory) => memory.name.toLowerCase() === lower);
  const partial = exact ?? all.find((memory) => memory.name.toLowerCase().startsWith(lower));
  if (!partial) {
    return failure(call, 'memory_not_found', '未找到记忆', `未找到匹配「${key}」的记忆，可先用 memory_list 列出标题`, false);
  }
  return memoryEntrySuccess(call, partial);
}

function memoryEntrySuccess(call: ToolCall, memory: Memory): ToolResult {
  // summary 只给标题，供工具卡片状态行展示；完整正文走 detail。
  return success(call, memory.name, formatMemoryEntry(memory), {
    id: memory.id ?? 0,
    type: memory.type,
    name: memory.name,
    scope: memory.scope,
    tags: memory.tags,
    silentInject: memory.silentInject === true,
    content: memory.content,
  });
}

async function saveMemory(runtime: MemoryToolRuntime, call: ToolCall): Promise<ToolResult> {
  const payload = call.payload;
  const name = stringValue(payload.name) || 'unnamed';
  const saved = await runtime.saveMemory({
    type: memoryTypeValue(payload.type) || 'topic',
    scope: memoryScopeValue(payload.scope) || 'contextual',
    name,
    content: stringValue(payload.content),
    tags: stringArrayValue(payload.tags),
    pinned: false,
    // memory_save 保存的记忆默认静默注入：模型主动存入的长期信息应在后续对话自动生效。
    silentInject: true,
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
