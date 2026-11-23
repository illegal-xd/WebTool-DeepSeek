/**
 * 运行方式（值导入不带 .ts 扩展，需先打包）：
 *   npx esbuild scripts/test_memory_tools_read.ts --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --outfile=/tmp/vc-test-memory-read.mjs && node /tmp/vc-test-memory-read.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeMemoryToolCall, type MemoryToolRuntime } from '../core/tool/memory.ts';
import type { Memory } from '../core/types.ts';
import type { ToolCall, ToolPayload } from '../core/tool/types.ts';

function memory(id: number, type: Memory['type'], name: string, content: string, tags: string[] = [], silentInject = false): Memory {
  return {
    id,
    syncId: `s-${id}`,
    type,
    scope: 'contextual',
    name,
    content,
    tags,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    accessCount: 0,
    lastAccessedAt: 0,
    silentInject,
  };
}

const memories: Memory[] = [
  memory(1, 'user', '我的设备', '19 年 MacBook Pro 16 寸；内存 32 GB', ['信息'], true),
  memory(89, 'topic', '红利低波定投触发条件', '当 PE 低于 10 时分批加仓', ['红利低波', '定投']),
  memory(102, 'reference', '常量表', '3+3=6', ['reference']),
];

const runtime: MemoryToolRuntime = {
  listMemories: async () => memories,
  saveMemory: async () => null,
  getMemoryById: async (id) => memories.find((item) => item.id === id) ?? null,
  updateMemory: async () => {},
  deleteMemory: async () => {},
};

function call(name: string, payload: ToolPayload = {}): ToolCall {
  return { name, payload, raw: '' };
}

test('memory_list 返回标题列表，不含正文', async () => {
  const result = await executeMemoryToolCall(runtime, call('memory_list'));
  assert.equal(result.ok, true);
  assert.match(result.summary, /共 3 条记忆/);
  assert.match(result.detail ?? '', /- #89 \[topic\] 红利低波定投触发条件/);
  assert.doesNotMatch(result.detail ?? '', /当 PE 低于 10 时分批加仓/, '列表不应包含正文');
});

test('memory_list 支持 query 过滤与 limit 截断', async () => {
  const filtered = await executeMemoryToolCall(runtime, call('memory_list', { query: '红利' }));
  assert.match(filtered.summary, /共 1 条记忆/);
  assert.match(filtered.detail ?? '', /#89/);

  const limited = await executeMemoryToolCall(runtime, call('memory_list', { limit: 2 }));
  assert.equal(limited.output && (limited.output as Record<string, unknown>).count, 3);
  assert.equal((limited.detail ?? '').split('\n').filter((line) => line.startsWith('- ')).length, 2);
});

test('memory_list 空结果给出明确提示', async () => {
  const empty = await executeMemoryToolCall(runtime, call('memory_list', { query: '不存在的记忆' }));
  assert.equal(empty.ok, true);
  assert.match(empty.summary, /没有匹配的记忆/);
});

test('memory_get 支持 ID、#ID 与标题匹配，返回完整正文', async () => {
  const byId = await executeMemoryToolCall(runtime, call('memory_get', { key: '89' }));
  assert.equal(byId.ok, true);
  assert.equal(byId.summary, '红利低波定投触发条件', '状态行只显示标题，不重复正文');
  assert.match(byId.detail ?? '', /#89 \[topic\] 红利低波定投触发条件/);
  assert.match(byId.detail ?? '', /当 PE 低于 10 时分批加仓/);
  assert.match(byId.detail ?? '', /标签：红利低波、定投/);

  const byHash = await executeMemoryToolCall(runtime, call('memory_get', { key: '#102' }));
  assert.match(byHash.detail ?? '', /3\+3=6/);

  const byName = await executeMemoryToolCall(runtime, call('memory_get', { key: '我的设备' }));
  assert.equal(byName.ok, true);
  assert.match(byName.detail ?? '', /19 年 MacBook Pro/);
});

test('memory_get 未找到时返回失败并提示先列标题', async () => {
  const missing = await executeMemoryToolCall(runtime, call('memory_get', { key: '不存在的记忆' }));
  assert.equal(missing.ok, false);
  assert.match(missing.detail ?? '', /memory_list/);
});

test('memory_get 缺少 key 参数时返回失败', async () => {
  const invalid = await executeMemoryToolCall(runtime, call('memory_get', {}));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, 'memory_invalid_key');
});

test('内置 memory_list / memory_get 标签可被 XML 解析识别', async () => {
  const { extractToolCalls } = await import('../core/interceptor/tool-parser.ts');
  const calls = extractToolCalls('<memory_list>{"limit":10}</memory_list>\n<memory_get>{"key":"#89"}</memory_get>');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'memory_list');
  assert.equal(calls[0].provider?.id, 'memory');
  assert.equal(calls[1].name, 'memory_get');
  assert.deepEqual(calls[1].payload, { key: '#89' });
});
