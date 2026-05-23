import type { McpJsonRpcNotification, McpJsonRpcRequest, McpJsonRpcResponse, McpProtocolTransport, McpServerConfig } from '../types';
import { ensureMcpServerOriginPermission, fetchWithTimeout, getMcpEndpointUrl, readJsonRpcResponse } from './common';

interface McpBridgeEnvelope {
  protocol: 'webtool-deepseek-mcp-bridge';
  version: 1;
  server: { id: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string> };
  message: McpJsonRpcRequest<Record<string, unknown> | undefined> | McpJsonRpcNotification;
}

export function createMcpBridgeTransport(server: McpServerConfig): McpProtocolTransport {
  return {
    request(request, options) {
      return sendBridgeMessage(server, request, options?.timeoutMs);
    },
    async notify(notification, options) {
      await sendBridgeMessage(server, notification, options?.timeoutMs);
    },
  };
}

async function sendBridgeMessage<TParams extends Record<string, unknown> | undefined, TResult>(server: McpServerConfig, message: McpJsonRpcRequest<TParams> | McpJsonRpcNotification, timeoutMs: number = server.timeouts.requestMs): Promise<McpJsonRpcResponse<TResult>> {
  await ensureMcpServerOriginPermission(server);
  const response = await fetchWithTimeout(getMcpEndpointUrl(server), { method: 'POST', credentials: 'omit', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(createBridgeEnvelope(server, message)) }, timeoutMs);
  return readJsonRpcResponse<TResult>(response, 'id' in message ? message as McpJsonRpcRequest<TParams> : undefined);
}

function createBridgeEnvelope(server: McpServerConfig, message: McpJsonRpcRequest<Record<string, unknown> | undefined> | McpJsonRpcNotification): McpBridgeEnvelope {
  return { protocol: 'webtool-deepseek-mcp-bridge', version: 1, server: { id: server.id, command: server.transport.command, args: server.transport.args, cwd: server.transport.cwd, env: server.transport.env }, message };
}
