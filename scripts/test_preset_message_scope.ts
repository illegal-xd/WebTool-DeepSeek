import assert from 'node:assert/strict';
import test from 'node:test';
import { modifyRequestBody, updateHookState } from '../core/interceptor/fetch-hook.ts';
import type { Memory, SystemPromptPreset } from '../core/types.ts';

function preset(id: string, name: string, content: string): SystemPromptPreset {
  return { id, name, content, createdAt: 0, updatedAt: 0 };
}

function resetState(presets: SystemPromptPreset[], memories: Memory[] = []) {
  updateHookState({
    memories,
    skills: [],
    presets,
    modelType: null,
    toolDescriptors: [],
    memoryTokenBudget: 3000,
  });
}

function buildPrompt(prompt: string, sessionId: string): string {
  const raw = JSON.stringify({
    prompt,
    thinking_enabled: false,
    chat_session_id: sessionId,
    parent_message_id: 'parent-message',
  });
  const modified = modifyRequestBody(raw);
  assert.ok(modified, 'modifyRequestBody 应返回改写后的请求体');
  return (JSON.parse(modified) as { prompt: string }).prompt;
}

const mine = preset('p-mine', '严谨模式', '你是严谨的工程助手，先给结论。');

test('@预设名 仅对当条消息生效：注入该预设指令并剥离 mention', () => {
  resetState([mine]);
  const prompt = buildPrompt('@严谨模式 帮我写代码', 'session-a');
  assert.match(prompt, /你是严谨的工程助手/);
  assert.match(prompt, /帮我写代码/);
  assert.doesNotMatch(prompt, /@严谨模式/);
});

test('无 mention 时不注入任何预设指令（不存在全局启用态）', () => {
  resetState([mine]);
  const prompt = buildPrompt('普通消息，不带 mention', 'session-b');
  assert.doesNotMatch(prompt, /你是严谨的工程助手/);
});

test('未匹配的 mention 原样保留，不误伤正文', () => {
  resetState([mine]);
  const prompt = buildPrompt('@不存在的预设 正文', 'session-c');
  assert.match(prompt, /@不存在的预设/);
});

test('#记忆名 手动注入回归（applyMemoryCommand 拆分后）', () => {
  const memory: Memory = {
    id: 7,
    syncId: 'm-7',
    type: 'topic',
    scope: 'contextual',
    name: '回答偏好',
    content: '偏好简洁回答',
    tags: [],
    pinned: false,
    accessCount: 0,
    lastAccessedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  resetState([], [memory]);
  const prompt = buildPrompt('#回答偏好 请回答', 'session-d');
  assert.match(prompt, /偏好简洁回答/);
  assert.match(prompt, /请回答/);
  assert.doesNotMatch(prompt, /#回答偏好 /);
});
