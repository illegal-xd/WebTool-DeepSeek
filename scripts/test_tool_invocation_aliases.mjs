import assert from 'node:assert/strict';
import { extractToolCalls, stripToolCalls } from '../core/interceptor/tool-parser.ts';
import { createToolMarkupStreamFilter } from '../core/interceptor/tool-stream-filter.ts';
import { createToolInvocationCatalog, createXmlToolCallRegex } from '../core/tool/index.ts';

function descriptor(serverId, name) {
  return {
    id: `mcp:${serverId}:${name}`,
    provider: { kind: 'mcp', id: serverId, displayName: serverId, transport: 'streamable_http' },
    name,
    invocationName: `mcp_${serverId}_${name}`,
    title: name,
    description: name,
    inputSchema: { type: 'object' },
    execution: { mode: 'auto', enabled: true, risk: 'medium' },
    annotations: { mcpServerId: serverId, mcpToolName: name },
  };
}

const memorySearch = descriptor('delx_memory', 'memory_search');
const memoryList = descriptor('delx_memory', 'memory_list');
const descriptors = [memorySearch, memoryList];
const raw = '<memory_search>\n{"query":"银行股分析简报","limit":10,"privacy_mode":"structured"}\n</memory_search>';
const calls = extractToolCalls(raw, { descriptors });

assert.equal(calls.length, 1, '唯一的 MCP 原始工具名应被识别为 XML 别名');
assert.equal(calls[0].name, 'memory_search');
assert.equal(calls[0].invocationName, memorySearch.invocationName);
assert.equal(calls[0].descriptorId, memorySearch.id);
assert.equal(calls[0].provider?.id, 'delx_memory');
assert.deepEqual(calls[0].payload, { query: '银行股分析简报', limit: 10, privacy_mode: 'structured' });
assert.equal(stripToolCalls(`前文\n${raw}\n后文`, { descriptors }), '前文\n\n后文');

const listRaw = '<memory_list>\n{"limit":50,"privacy_mode":"structured"}\n</memory_list>';
const listCalls = extractToolCalls(listRaw, { descriptors });
assert.equal(listCalls.length, 1, 'memory_list 短标签也应被识别');
assert.equal(listCalls[0].descriptorId, memoryList.id);
assert.equal(listCalls[0].provider?.id, 'delx_memory');
assert.deepEqual(listCalls[0].payload, { limit: 50, privacy_mode: 'structured' });

const streamFilter = createToolMarkupStreamFilter({ descriptors });
const visible = streamFilter.push('前文<memory_search>')
  + streamFilter.push('{"query":"银行股分析简报"}</memory_search>后文')
  + streamFilter.flush();
assert.equal(visible, '前文后文', 'SSE 流中使用短标签的原始工具内容不应显示');

const duplicateCatalog = createToolInvocationCatalog([
  descriptor('server_a', 'memory_search'),
  descriptor('server_b', 'memory_search'),
]);
assert.equal(
  createXmlToolCallRegex(duplicateCatalog).test(raw),
  false,
  '多个 MCP 服务有同名工具时不得启用有歧义的短标签',
);

console.log('tool invocation alias behavior tests passed');
