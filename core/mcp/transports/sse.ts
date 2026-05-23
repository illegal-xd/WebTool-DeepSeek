import { buildMcpRequestHeaders } from '../store';
import type { McpJsonRpcNotification, McpJsonRpcRequest, McpJsonRpcResponse, McpProtocolTransport, McpServerConfig } from '../types';
import { McpTransportError, drainSseEvents, ensureMcpServerOriginPermission, fetchWithTimeout, getMcpEndpointUrl, normalizeJsonRpcResponse } from './common';

export function createMcpSseTransport(server: McpServerConfig): McpProtocolTransport {
  return {
    request(request, options) {
      return sendSseMessage(server, request, options?.timeoutMs);
    },
    async notify(notification, options) {
      await sendSseMessage(server, notification, options?.timeoutMs);
    },
  };
}

async function sendSseMessage<TParams extends Record<string, unknown> | undefined, TResult>(server: McpServerConfig, message: McpJsonRpcRequest<TParams> | McpJsonRpcNotification, timeoutMs: number = server.timeouts.requestMs): Promise<McpJsonRpcResponse<TResult>> {
  await ensureMcpServerOriginPermission(server);
  const sseResponse = await fetchWithTimeout(getMcpEndpointUrl(server), { method: 'GET', credentials: 'omit', headers: { accept: 'text/event-stream', ...buildMcpRequestHeaders(server) } }, timeoutMs);
  if (!sseResponse.ok || !sseResponse.body) throw new McpTransportError('mcp_sse_connect_failed', `MCP SSE connect failed with HTTP ${sseResponse.status}.`);
  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  const postUrl = await readSseEndpoint(server, reader, decoder, timeoutMs);
  await postSseMessage(server, postUrl, message, timeoutMs);
  if (!('id' in message)) {
    reader.cancel().catch(() => undefined);
    return { jsonrpc: '2.0', id: null, result: undefined as TResult };
  }
  try {
    return await readSseResponseFromReader(reader, decoder, message as McpJsonRpcRequest<TParams>);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function readSseEndpoint(server: McpServerConfig, reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, timeoutMs: number): Promise<URL> {
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const drained = drainSseEvents(buffer);
    buffer = drained.remainder;
    for (const event of drained.events) if (event.event === 'endpoint') return new URL(event.data, getMcpEndpointUrl(server));
  }
  throw new McpTransportError('mcp_sse_endpoint_missing', 'MCP SSE stream did not provide a POST endpoint.');
}

async function postSseMessage(server: McpServerConfig, postUrl: URL, message: McpJsonRpcRequest<Record<string, unknown> | undefined> | McpJsonRpcNotification, timeoutMs: number): Promise<void> {
  const response = await fetchWithTimeout(postUrl, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', ...buildMcpRequestHeaders(server) }, body: JSON.stringify(message) }, timeoutMs);
  if (!response.ok) throw new McpTransportError('mcp_sse_post_failed', `MCP SSE POST failed with HTTP ${response.status}.`);
}

async function readSseResponseFromReader<TResult>(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, expectedRequest: McpJsonRpcRequest<Record<string, unknown> | undefined>): Promise<McpJsonRpcResponse<TResult>> {
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const drained = drainSseEvents(buffer);
    buffer = drained.remainder;
    for (const event of drained.events) {
      if (event.event !== 'message') continue;
      const parsed = tryParseJson(event.data);
      if (!parsed) continue;
      const normalized = normalizeJsonRpcResponse<TResult>(parsed, expectedRequest);
      if (normalized.id === expectedRequest.id) return normalized;
    }
  }
  throw new McpTransportError('mcp_sse_response_missing', 'MCP SSE stream ended without a matching response.');
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
