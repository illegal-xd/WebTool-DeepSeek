/**
 * 运行方式（值导入不带 .ts 扩展，需先打包）：
 *   npx esbuild scripts/test_mcp_memory_tool_display.ts --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --outfile=/tmp/vc-test-mcp-display.mjs && node /tmp/vc-test-mcp-display.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMcpToolDescriptor } from '../core/mcp/client.ts';
import type { McpServerConfig, McpToolDefinition } from '../core/mcp/types.ts';

const server = {
  id: 'delx-memory',
  displayName: 'delx-memory',
  enabled: true,
  execution: { mode: 'auto', enabled: true },
  allowlist: { mode: 'all', toolNames: [] },
  transport: { kind: 'streamable_http' },
  timeouts: { requestMs: 1000 },
  limits: { maxResultBytes: 1000 },
} as unknown as McpServerConfig;

function tool(name: string, description = 'raw mcp description'): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties: {} } };
}

test('记忆工具使用中文可读描述，不再落到「外部 MCP 工具」', () => {
  const list = normalizeMcpToolDescriptor(server, tool('memory_list', 'List keys'));
  assert.equal(list.title, '列出记忆标题');
  assert.match(list.description, /不含正文/);
  assert.equal(list.invocationName, 'mcp_delx_memory_memory_list');

  const get = normalizeMcpToolDescriptor(server, tool('memory_get', 'Get one entry'));
  assert.equal(get.title, '读取记忆全文');
  assert.match(get.description, /按 key 读取/);
});

test('未知 MCP 工具仍回退到通用描述', () => {
  const other = normalizeMcpToolDescriptor(server, tool('some_unknown_tool'));
  assert.equal(other.title, '外部 MCP 工具');
  assert.match(other.description, /some_unknown_tool/);
});
