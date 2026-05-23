import type { McpJsonRpcRequest, McpJsonRpcResponse, McpServerConfig } from '../types';

export class McpTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'McpTransportError';
    this.code = code;
    this.retryable = options?.retryable ?? true;
  }
}

export function getMcpEndpointUrl(server: McpServerConfig): URL {
  const url = server.transport.url;
  if (!url) throw new McpTransportError('mcp_endpoint_missing', 'MCP server URL is missing.', { retryable: false });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported protocol');
    return parsed;
  } catch {
    throw new McpTransportError('mcp_endpoint_invalid', `Invalid MCP server URL: ${url}`, { retryable: false });
  }
}

export function getMcpOriginPattern(server: McpServerConfig): string {
  const url = getMcpEndpointUrl(server);
  return `${url.protocol}//${url.host}/*`;
}

export async function requestMcpServerOriginPermission(server: McpServerConfig): Promise<boolean> {
  const origins = [getMcpOriginPattern(server)];
  if (!chrome.permissions?.contains || !chrome.permissions?.request) return true;
  const granted = await chrome.permissions.contains({ origins }).catch(() => false);
  if (granted) return true;
  return chrome.permissions.request({ origins }).catch(() => false);
}

export async function ensureMcpServerOriginPermission(server: McpServerConfig): Promise<void> {
  const granted = await requestMcpServerOriginPermission(server);
  if (!granted) {
    throw new McpTransportError('mcp_origin_permission_denied', `Host permission was not granted for ${getMcpOriginPattern(server)}.`, { retryable: false });
  }
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new McpTransportError('mcp_transport_timeout', `MCP request exceeded ${timeoutMs} ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readJsonRpcResponse<TResult>(response: Response, expectedRequest?: McpJsonRpcRequest<Record<string, unknown> | undefined>): Promise<McpJsonRpcResponse<TResult>> {
  if (!response.ok) {
    throw new McpTransportError('mcp_http_error', `MCP server returned HTTP ${response.status}.`, { retryable: response.status >= 500 });
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) return readSseJsonRpcResponse(response, expectedRequest);
  const raw = await response.text();
  if (!raw.trim()) return { jsonrpc: '2.0', id: expectedRequest?.id ?? null, result: undefined as TResult };
  return normalizeJsonRpcResponse(JSON.parse(raw), expectedRequest);
}

export async function readSseJsonRpcResponse<TResult>(response: Response, expectedRequest?: McpJsonRpcRequest<Record<string, unknown> | undefined>): Promise<McpJsonRpcResponse<TResult>> {
  if (!response.body) throw new McpTransportError('mcp_sse_empty_body', 'MCP SSE response did not include a body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = drainSseEvents(buffer);
    buffer = events.remainder;
    for (const event of events.events) {
      const parsed = parseJsonEvent(event.data);
      if (!parsed) continue;
      const normalized = normalizeJsonRpcResponse<TResult>(parsed, expectedRequest);
      if (expectedRequest == null || normalized.id === expectedRequest.id || normalized.id === null) return normalized;
    }
  }
  throw new McpTransportError('mcp_sse_response_missing', 'MCP SSE stream ended without a matching response.');
}

export interface SseEvent {
  event: string;
  data: string;
}

export function drainSseEvents(buffer: string): { events: SseEvent[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const boundary = normalized.lastIndexOf('\n\n');
  if (boundary === -1) return { events: [], remainder: buffer };
  const complete = normalized.slice(0, boundary);
  const remainder = normalized.slice(boundary + 2);
  const events = complete.split('\n\n').map(parseSseEvent).filter((event): event is SseEvent => event !== null);
  return { events, remainder };
}

export function normalizeJsonRpcResponse<TResult>(raw: unknown, expectedRequest?: McpJsonRpcRequest<Record<string, unknown> | undefined>): McpJsonRpcResponse<TResult> {
  if (!raw || typeof raw !== 'object') throw new McpTransportError('mcp_response_invalid', 'MCP response was not a JSON object.');
  const value = raw as Partial<McpJsonRpcResponse<TResult>>;
  return { jsonrpc: '2.0', id: value.id ?? expectedRequest?.id ?? null, result: value.result, error: value.error };
}

function parseSseEvent(block: string): SseEvent | null {
  const lines = block.split('\n');
  let event = 'message';
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

function parseJsonEvent(data: string): unknown | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
