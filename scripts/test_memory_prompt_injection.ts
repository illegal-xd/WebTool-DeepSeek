import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAugmentedPrompt, buildLightweightMemoryPrompt, setTemplateOverrides } from '../core/memory/injector.ts';
import type { Memory, ToolDescriptor } from '../core/types.ts';

const memoryGetTool: ToolDescriptor = {
  id: 'mcp:delx-memory:memory_get',
  provider: {
    kind: 'mcp',
    id: 'delx-memory',
    displayName: 'delx-memory',
    transport: 'streamable_http',
  },
  name: 'memory_get',
  invocationName: 'memory_get',
  title: '读取记忆全文',
  description: '按 key 读取单条记忆的完整内容',
  inputSchema: { type: 'object', properties: {} },
  execution: { mode: 'auto', enabled: true, risk: 'low' },
};

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
  assert.doesNotMatch(augmented, /### 工具 memory_list/);
});

test('injects the memory context section when selected memories exist', () => {
  const memory: Memory = {
    id: 1,
    type: 'user',
    scope: 'permanent',
    name: '回答偏好',
    content: '偏好简洁回答',
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

test('列出记忆场景明确要求不要调用 memory_get 逐条读取', () => {
  const { augmented } = buildAugmentedPrompt('我以前保存了什么？', [], {
    toolDescriptors: [memoryListTool],
  });

  assert.match(augmented, /未注入[「“]?已知信息[」”]?不代表记忆库为空/);
  assert.match(augmented, /列出\/浏览记忆时直接使用「已知信息」中的标题索引回答/);
  assert.match(augmented, /不要调用 memory_get 逐条读取/);
  assert.match(augmented, /只有用户明确要查看某条记忆的具体内容时，才调用 memory_get/);
});

test('lightweight injection keeps the original prompt when no context, instruction, or memory reader exists', () => {
  const originalPrompt = '继续';
  const { augmented, usedMemoryIds } = buildLightweightMemoryPrompt(originalPrompt, []);

  assert.equal(augmented, originalPrompt);
  assert.deepEqual(usedMemoryIds, []);
});

test('lightweight injection 不重复注入「## 使用说明」与工具 schema', () => {
  const memory: Memory = {
    id: 2,
    type: 'topic',
    scope: 'contextual',
    name: '项目规范',
    content: '使用 pnpm',
    tags: ['规范'],
    pinned: false,
    accessCount: 0,
    lastAccessedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncId: 'memory-2',
  };
  const { augmented, usedMemoryIds } = buildLightweightMemoryPrompt('继续实现', [memory], {
    toolDescriptors: [memoryListTool, memoryGetTool],
  });

  assert.deepEqual(usedMemoryIds, [2]);
  assert.match(augmented, /## 补充上下文/);
  assert.match(augmented, /#2 \[topic\] 项目规范/);
  assert.doesNotMatch(augmented, /## 使用说明/);
  assert.doesNotMatch(augmented, /### 工具 memory_get/);
  assert.doesNotMatch(augmented, /### 工具 memory_list/);
});

test('lightweight injection with only user input stays minimal', () => {
  const { augmented } = buildLightweightMemoryPrompt('继续', [], {
    toolDescriptors: [memoryGetTool],
  });

  assert.equal(augmented, '继续');
});

test('首轮注入把记忆读取说明并入「## 使用说明」，不再单独成段', () => {
  const memory: Memory = {
    id: 1,
    type: 'user',
    scope: 'permanent',
    name: '回答偏好',
    content: '偏好简洁回答',
    tags: ['偏好'],
    pinned: false,
    accessCount: 0,
    lastAccessedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncId: 'memory-1',
  };
  const { augmented } = buildAugmentedPrompt('获取记忆列表', [memory], {
    toolDescriptors: [memoryListTool, memoryGetTool],
  });

  assert.match(augmented, /## 使用说明/);
  assert.doesNotMatch(augmented, /## 记忆查询/);
  assert.match(augmented, /（仅标题）/);
  assert.match(augmented, /memory_get/);
  assert.match(augmented, /不要凭标题猜测记忆内容/);
  assert.doesNotMatch(augmented, /### 工具 memory_list/);
  assert.doesNotMatch(augmented, /列出记忆标题：/);
});

test('没有记忆查询工具时「## 使用说明」仍包含 memory_get 用法', () => {
  const { augmented } = buildAugmentedPrompt('获取记忆列表', [], {
    toolDescriptors: [],
  });

  assert.match(augmented, /## 使用说明/);
  assert.doesNotMatch(augmented, /## 记忆查询/);
  assert.match(augmented, /（仅标题）/);
  assert.match(augmented, /memory_get（key 填记忆 ID/);
  assert.doesNotMatch(augmented, /mcp_/);
});
