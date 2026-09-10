import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAugmentedPrompt, buildLightweightMemoryPrompt, setTemplateOverrides } from '../core/memory/injector.ts';
import type { Memory, ToolDescriptor } from '../core/types.ts';

const memoryListTool: ToolDescriptor = {
  id: 'mcp:delx-memory:memory_list',
  provider: {
    kind: 'mcp',
    id: 'delx-memory',
    displayName: 'delx-memory',
    transport: 'streamable_http',
  },
  name: 'memory_list',
  invocationName: 'memory_list',
  title: '列出记忆',
  description: '查询记忆列表',
  inputSchema: { type: 'object', properties: {} },
  execution: { mode: 'auto', enabled: true, risk: 'low' },
};

test('does not inject an empty memory context section', () => {
  const { augmented, usedMemoryIds } = buildAugmentedPrompt('列出我的长期记忆', [], {
    toolDescriptors: [memoryListTool],
  });

  assert.deepEqual(usedMemoryIds, []);
  assert.doesNotMatch(augmented, /## 补充上下文/);
  assert.doesNotMatch(augmented, /### 已知信息/);
  assert.doesNotMatch(augmented, /\(暂无记忆\)/);
  assert.match(augmented, /memory_list/);
});

test('injects the memory context section when selected memories exist', () => {
  const memory: Memory = {
    id: 1,
    type: 'user',
    scope: 'permanent',
    name: '回答偏好',
    content: '偏好简洁回答',
    description: '回答偏好',
    tags: ['偏好'],
    pinned: true,
    accessCount: 1,
    lastAccessedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncId: 'memory-1',
  };
  const { augmented } = buildAugmentedPrompt('请回答', [memory], {
    toolDescriptors: [memoryListTool],
  });

  assert.match(augmented, /## 补充上下文/);
  assert.match(augmented, /### 已知信息/);
  assert.match(augmented, /回答偏好/);
});

test('removes empty memory headings from legacy custom system templates', () => {
  setTemplateOverrides({
    SYSTEM_TEMPLATE_CHAT: '## 补充上下文\n\n### 已知信息\n{{memories}}\n\n## 工具\n{{tools}}',
  });
  try {
    const { augmented } = buildAugmentedPrompt('列出记忆', [], {
      toolDescriptors: [memoryListTool],
    });
    assert.doesNotMatch(augmented, /## 补充上下文/);
    assert.doesNotMatch(augmented, /### 已知信息/);
    assert.match(augmented, /## 工具/);
  } finally {
    setTemplateOverrides({});
  }
});

test('empty selected context tells the agent to query available memory tools', () => {
  const { augmented } = buildAugmentedPrompt('我以前保存了什么？', [], {
    toolDescriptors: [memoryListTool],
  });

  assert.match(augmented, /未注入[「“]?已知信息[」”]?不代表记忆库为空/);
  assert.match(augmented, /记忆查询或列表工具/);
  assert.match(augmented, /主动调用/);
});

test('lightweight injection keeps the original prompt when no context, instruction, or memory reader exists', () => {
  const originalPrompt = '继续';
  const { augmented, usedMemoryIds } = buildLightweightMemoryPrompt(originalPrompt, []);

  assert.equal(augmented, originalPrompt);
  assert.deepEqual(usedMemoryIds, []);
});

test('lightweight preset injection keeps memory lookup available beyond selected memories', () => {
  const unrelatedTool: ToolDescriptor = {
    ...memoryListTool,
    id: 'mcp:web:search',
    provider: { ...memoryListTool.provider, id: 'web' },
    name: 'web_search',
    invocationName: 'web_search',
    title: '网页搜索',
  };
  const destructiveTool: ToolDescriptor = {
    ...memoryListTool,
    id: 'mcp:delx-memory:memory_forget',
    name: 'memory_forget',
    invocationName: 'mcp_delx_memory_memory_forget',
    title: '删除记忆',
  };
  const { augmented } = buildLightweightMemoryPrompt('查看项目规范记忆内容', [], {
    toolDescriptors: [memoryListTool, destructiveTool, unrelatedTool],
  });

  assert.match(augmented, /选中的记忆仅限定自动注入范围/);
  assert.match(augmented, /不限制访问记忆库中的其他记忆/);
  assert.match(augmented, /memory_list/);
  assert.match(augmented, /查询记忆列表/);
  assert.doesNotMatch(augmented, /memory_forget/);
  assert.doesNotMatch(augmented, /web_search/);
});
