import assert from 'node:assert/strict';
import { buildCustomMemoryPrompt } from '../core/memory/injector.ts';
import { DEFAULT_CUSTOM_MEMORY_PROMPT } from '../core/memory/config.ts';
import type { ToolDescriptor } from '../core/tool';

function descriptor(partial: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    id: partial.id ?? 'tool:test',
    provider: partial.provider ?? { kind: 'mcp', id: 'delx-memory', displayName: 'delx-memory', transport: 'streamable_http' },
    name: partial.name ?? 'remember',
    invocationName: partial.invocationName ?? 'mcp_delx_memory_remember',
    title: partial.title ?? 'Remember',
    description: partial.description ?? 'Store a memory',
    inputSchema: partial.inputSchema ?? { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    execution: partial.execution ?? { mode: 'auto', enabled: true, risk: 'medium' },
  };
}

const localMemoryTool = descriptor({
  id: 'local:memory:memory_save',
  provider: { kind: 'local', id: 'memory', displayName: 'WebTool Memory', transport: 'in_process' },
  name: 'memory_save',
  invocationName: 'memory_save',
});

const mcpMemoryTool = descriptor({
  id: 'mcp:delx-memory:remember',
  name: 'remember',
  invocationName: 'mcp_delx_memory_remember',
});

const { augmented, usedMemoryIds } = buildCustomMemoryPrompt(
  '请记住我喜欢简洁回答',
  '自定义记忆提示：使用 delx-memory MCP 工具管理长期记忆。',
  { toolDescriptors: [localMemoryTool, mcpMemoryTool] },
);

assert.equal(usedMemoryIds.length, 0);
assert.match(augmented, /自定义记忆提示/);
assert.match(augmented, /mcp_delx_memory_remember/);
assert.match(augmented, /以下是用户本次输入/);
assert.doesNotMatch(augmented, /你是用户的私人 AI 助手/);
assert.doesNotMatch(augmented, /memory_save/);

const withDefaultTemplate = buildCustomMemoryPrompt(
  '请记住我喜欢简洁回答',
  DEFAULT_CUSTOM_MEMORY_PROMPT,
  { toolDescriptors: [localMemoryTool, mcpMemoryTool] },
).augmented;

assert.match(withDefaultTemplate, /你是用户的私人 AI 助手/);
assert.match(withDefaultTemplate, /mcp_delx_memory_remember/);
assert.doesNotMatch(withDefaultTemplate, /\{\{memories\}\}/);
assert.doesNotMatch(withDefaultTemplate, /\{\{tools\}\}/);

console.log('ok - custom memory prompt hydrates custom instructions and keeps MCP tools');
