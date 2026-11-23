import { APP_VERSION } from '../../config.js';
import type { JsonValue, ToolCall, ToolDescriptor, ToolDescriptorSchema, ToolResult, ToolTransportKind } from '../tool/types';
import type { McpCallToolOptions, McpCallToolResult, McpContentBlock, McpInitializeResult, McpJsonRpcNotification, McpJsonRpcRequest, McpJsonRpcResponse, McpListToolsResult, McpProtocolClient, McpProtocolTransport, McpServerConfig, McpToolDefinition } from './types';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

const CLIENT_INFO = { name: 'WebTool-DeepSeek', version: APP_VERSION };

export class McpProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options?: { retryable?: boolean; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export function createMcpProtocolClient(server: McpServerConfig, transport: McpProtocolTransport): McpProtocolClient {
  return {
    initialize: () => initializeMcpServer(server, transport),
    listTools: () => listMcpTools(server, transport),
    callTool: (options) => callMcpTool(server, transport, options),
  };
}

export async function initializeMcpServer(server: McpServerConfig, transport: McpProtocolTransport): Promise<McpInitializeResult> {
  const response = await transport.request<Record<string, unknown>, McpInitializeResult>(createMcpRequest('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, clientInfo: CLIENT_INFO }), { timeoutMs: server.timeouts.connectMs });
  const result = unwrapMcpResponse(response, 'mcp_initialize_failed');
  if (transport.notify) await transport.notify(createMcpNotification('notifications/initialized'), { timeoutMs: server.timeouts.requestMs });
  const rawResult = result as unknown as Record<string, unknown>;
  return { protocolVersion: stringValue(rawResult.protocolVersion) || MCP_PROTOCOL_VERSION, capabilities: jsonRecordValue(rawResult.capabilities), serverInfo: clientInfoValue(rawResult.serverInfo), instructions: stringValue(rawResult.instructions) };
}

export async function listMcpTools(server: McpServerConfig, transport: McpProtocolTransport): Promise<ToolDescriptor[]> {
  const tools: ToolDescriptor[] = [];
  let cursor: string | undefined;
  do {
    const response = await transport.request<Record<string, unknown>, McpListToolsResult>(createMcpRequest('tools/list', cursor ? { cursor } : undefined), { timeoutMs: server.timeouts.discoveryMs });
    const result = unwrapMcpResponse(response, 'mcp_tools_list_failed') as McpListToolsResult;
    const nextTools = Array.isArray(result.tools) ? result.tools : [];
    tools.push(...nextTools.map((tool) => normalizeMcpToolDescriptor(server, tool)));
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
  } while (cursor && tools.length < server.limits.maxToolCount);
  return applyMcpToolPolicy(tools, server);
}

export async function callMcpTool(server: McpServerConfig, transport: McpProtocolTransport, options: McpCallToolOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  const mcpToolName = getMcpToolName(options.call, options.descriptor);
  try {
    const response = await transport.request<Record<string, unknown>, McpCallToolResult>(createMcpRequest('tools/call', { name: mcpToolName, arguments: options.call.payload }), { timeoutMs: options.timeoutMs ?? server.timeouts.requestMs });
    const result = unwrapMcpResponse(response, 'mcp_tool_call_failed') as McpCallToolResult;
    return normalizeMcpToolResult(server, options.call, result, startedAt, options.maxResultBytes);
  } catch (err) {
    return { ok: false, summary: 'MCP 工具调用失败', detail: err instanceof Error ? err.message : String(err), name: options.call.name, provider: options.call.provider, descriptorId: options.call.descriptorId, startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt, error: { code: err instanceof McpProtocolError ? err.code : 'mcp_tool_call_failed', message: err instanceof Error ? err.message : String(err), retryable: err instanceof McpProtocolError ? err.retryable : true, details: err instanceof McpProtocolError ? err.details : undefined } };
  }
}

export function normalizeMcpToolDescriptor(server: McpServerConfig, tool: McpToolDefinition): ToolDescriptor {
  const invocationName = createMcpInvocationName(server.id, tool.name);
  const display = getMcpToolDisplay(tool);
  return { id: createMcpDescriptorId(server.id, tool.name), provider: { kind: 'mcp', id: server.id, displayName: server.displayName, transport: server.transport.kind as ToolTransportKind }, name: tool.name, invocationName, title: display.title, description: display.description, inputSchema: normalizeToolSchema(tool.inputSchema), outputSchema: normalizeToolSchema(tool.outputSchema), execution: { mode: server.execution.mode, enabled: server.enabled && server.execution.enabled, risk: 'medium', timeoutMs: server.timeouts.requestMs, maxResultBytes: server.limits.maxResultBytes }, annotations: { mcpServerId: server.id, mcpToolName: tool.name } };
}

function getMcpToolDisplay(tool: McpToolDefinition): { title: string; description: string } {
  const displayByName: Record<string, { title: string; description: string }> = {
    ping: { title: '连通性检测', description: '返回 pong 与服务端当前时间，用于验证 MCP 服务是否可用。' },
    echo: { title: '文本回显', description: '回显传入文本，用于验证 MCP 工具参数传递是否正常。' },
    add: { title: '数字相加', description: '计算两个数字之和，并返回结构化结果。' },
    stock_tech: { title: 'A 股技术分析', description: '查询 A 股实时行情，并计算 MACD、RSI、KDJ、布林带和量比等技术指标。' },
    get_cwd: { title: '查看工作区', description: '返回 MCP 服务当前受限工作区根目录。' },
    list_directory: { title: '列出目录', description: '列出受限工作区内指定目录的文件和子目录。' },
    read_file: { title: '读取文件', description: '读取受限工作区内的文本文件内容。' },
    write_file: { title: '写入文件', description: '向受限工作区内的文本文件写入内容。' },
    execute_command: { title: '执行命令', description: '在受限工作区内执行经过安全策略检查的 shell 命令。' },
    bing_search: { title: 'Bing 网页搜索', description: '使用 Bing Search API 搜索网页内容。' },
    crawl_webpage: { title: '抓取网页', description: '抓取指定网页并提取可阅读的纯文本内容。' },
    'resolve-library-id': { title: '解析文档库 ID', description: '通过 Context7 根据库名和问题查找可用的文档库 ID。' },
    'query-docs': { title: '查询文档', description: '通过 Context7 查询指定文档库中的相关技术文档内容。' },
    // delx-memory 等本地记忆 MCP：让工具列表里的描述可读且说明「列表只给标题、正文按需读取」。
    memory_list: { title: '列出记忆标题', description: '列出记忆库中的记忆标题（key，不含正文），支持标题前缀/标签/更新时间过滤。' },
    memory_get: { title: '读取记忆全文', description: '按 key 读取单条记忆的完整内容、标签与元数据。' },
    memory_get_many: { title: '批量读取记忆', description: '按 key 批量读取记忆（最多 50 条），缺失的 key 自动跳过。' },
    memory_search: { title: '检索记忆', description: '全文检索记忆的标题、正文与标签，返回匹配条目与内容片段。' },
    memory_stats: { title: '记忆库概况', description: '返回记忆总数、数据库大小与存储路径。' },
    memory_handoff: { title: '记忆交接摘要', description: '返回记忆库概况与最近更新的记忆列表（可选正文），用于会话开始恢复上下文。' },
    memory_set: { title: '写入记忆', description: '按 key 新增或覆盖一条记忆（需显式用户意图）。' },
    memory_set_batch: { title: '批量写入记忆', description: '在一个事务中批量写入最多 50 条记忆。' },
    memory_forget: { title: '删除记忆', description: '删除指定 key 的记忆，幂等。' },
    memory_forget_by_tag: { title: '按标签删除记忆', description: '删除所有带指定标签的记忆。' },
    memory_export: { title: '导出记忆', description: '导出整个记忆库（JSON/JSONL/Markdown），需显式用户意图。' },
    memory_connection_status: { title: '记忆连接状态', description: '返回本地记忆库路径是否就绪与文件大小。' },
    memory_capabilities: { title: '记忆能力说明', description: '返回该 MCP 的能力与隐私模式说明。' },
    memory_data_inventory: { title: '记忆数据清单', description: '返回记忆域、隐私模式与推荐的首批调用。' },
    memory_agent_manifest: { title: 'Agent 安装说明', description: '返回面向 AI Agent 的安装与操作说明。' },
  };
  const known = displayByName[tool.name];
  if (known) return known;
  return { title: '外部 MCP 工具', description: `来自外部 MCP 服务的工具，原始工具名为 ${tool.name}。` };
}

export function applyMcpToolPolicy(tools: ToolDescriptor[], server: McpServerConfig): ToolDescriptor[] {
  const names = new Set(server.allowlist.toolNames);
  return tools.map((tool) => {
    const selected = names.has(tool.name) || names.has(tool.invocationName);
    const allowed = server.allowlist.mode === 'all' ? true : server.allowlist.mode === 'allow' ? selected : !selected;
    return { ...tool, provider: { ...tool.provider, displayName: server.displayName, transport: server.transport.kind as ToolTransportKind }, execution: { ...tool.execution, mode: server.execution.mode, enabled: server.enabled && server.execution.enabled && server.execution.mode !== 'disabled' && allowed, timeoutMs: server.timeouts.requestMs, maxResultBytes: server.limits.maxResultBytes } };
  });
}

export function createMcpRequest<TParams extends Record<string, unknown> | undefined>(method: string, params?: TParams): McpJsonRpcRequest<TParams> {
  return { jsonrpc: '2.0', id: crypto.randomUUID(), method, ...(params ? { params } : {}) };
}

export function createMcpNotification<TParams extends Record<string, unknown> | undefined>(method: string, params?: TParams): McpJsonRpcNotification<TParams> {
  return { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
}

export function unwrapMcpResponse<TResult>(response: McpJsonRpcResponse<TResult>, errorCode: string): TResult {
  if (response.error) throw new McpProtocolError(errorCode, response.error.message, { retryable: response.error.code === -32000 || response.error.code === -32603, details: { code: response.error.code, data: response.error.data } });
  return response.result as TResult;
}

function createMcpDescriptorId(serverId: string, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

function createMcpInvocationName(serverId: string, toolName: string): string {
  return `mcp_${safeName(serverId)}_${safeName(toolName)}`.slice(0, 80);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

function getMcpToolName(call: ToolCall, descriptor?: ToolDescriptor): string {
  return descriptor?.annotations?.mcpToolName || call.name;
}

function normalizeToolSchema(schema: JsonValue | undefined): ToolDescriptorSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {}, additionalProperties: true };
  const value = schema as Record<string, JsonValue>;
  return { type: 'object', properties: isRecord(value.properties) ? value.properties : {}, required: Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === 'string') : [], additionalProperties: typeof value.additionalProperties === 'boolean' ? value.additionalProperties : true, description: stringValue(value.description) };
}

function normalizeMcpToolResult(server: McpServerConfig, call: ToolCall, result: McpCallToolResult, startedAt: number, maxBytes?: number): ToolResult {
  const completedAt = Date.now();
  const text = formatMcpContent(result.content);
  const output: JsonValue = toJsonValue(result.structuredContent) ?? (text ? { text } : { content: [] });
  const serialized = JSON.stringify(output);
  const limit = maxBytes ?? server.limits.maxResultBytes;
  const truncated = serialized.length > limit;
  return { ok: result.isError !== true, summary: result.isError ? 'MCP 工具返回错误' : 'MCP 工具调用完成', detail: truncated ? serialized.slice(0, limit) : text || serialized, output: truncated ? { truncated: true, preview: serialized.slice(0, limit) } : output, truncated, name: call.name, provider: call.provider, descriptorId: call.descriptorId, startedAt, completedAt, durationMs: completedAt - startedAt, error: result.isError ? { code: 'mcp_tool_result_error', message: text || 'MCP tool returned isError=true', retryable: false } : undefined };
}

function formatMcpContent(content: McpContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content.map((block) => block.text || block.uri || block.name || JSON.stringify(block)).join('\n');
}

function clientInfoValue(value: unknown): { name: string; version: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const name = stringValue(raw.name);
  const version = stringValue(raw.version);
  return name || version ? { name, version } : undefined;
}

function jsonRecordValue(value: unknown): Record<string, JsonValue> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item) ?? null);
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, entryValue]) => [key, toJsonValue(entryValue) ?? null] as const);
    return Object.fromEntries(entries) as Record<string, JsonValue>;
  }
  return String(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
