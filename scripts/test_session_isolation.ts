/**
 * 运行方式（值导入不带 .ts 扩展，需先打包）：
 *   npx esbuild scripts/test_session_isolation.ts --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --outfile=/tmp/vc-test-session.mjs && node /tmp/vc-test-session.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const sessionStore = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  sessionStorage: {
    getItem: (key: string) => sessionStore.get(key) ?? null,
    setItem: (key: string, value: string) => { sessionStore.set(key, value); },
  },
  location: { pathname: '/a/chat/s/session-a', href: 'https://chat.deepseek.com/a/chat/s/session-a' },
  localStorage: { getItem: () => null },
};

const { updateHookState, modifyRequestBody, getInjectedMemoryIdsForContext } = await import('../core/interceptor/fetch-hook.ts');
const { DEFAULT_TOOL_DESCRIPTORS } = await import('../core/tool/index.ts');

const locationMock = (globalThis as unknown as { window: { location: { pathname: string } } }).window.location;

function setPath(pathname: string) {
  locationMock.pathname = pathname;
}

function memory(id: number, name: string, content: string, silentInject = false) {
  return {
    id,
    syncId: `s-${id}`,
    type: 'user' as const,
    scope: 'permanent' as const,
    name,
    content,
    tags: [] as string[],
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    accessCount: 0,
    lastAccessedAt: 0,
    silentInject,
  };
}

function reset(extra: Record<string, unknown> = {}) {
  updateHookState({
    memories: [memory(1, '全局偏好', '始终使用中文回答', true)],
    skills: [],
    presets: [],
    toolDescriptors: [...DEFAULT_TOOL_DESCRIPTORS],
    customMemoryEnabled: false,
    pendingContinuationPrompt: null,
    pendingContinuationAt: 0,
    ...extra,
  });
}

function request(prompt: string, chatSessionId: string | null, parentMessageId: string | null): string {
  const out = modifyRequestBody(JSON.stringify({
    prompt,
    chat_session_id: chatSessionId,
    parent_message_id: parentMessageId,
    thinking_enabled: false,
  }));
  assert.ok(out, 'modifyRequestBody 不应返回 null');
  return JSON.parse(out).prompt as string;
}

test('新对话会重新注入静默记忆（不继承上一对话的已注入记录）', () => {
  reset();
  setPath('/a/chat/s/session-a');
  const first = request('聊天气', 'session-a', 'msg-1');
  assert.ok(first.includes('始终使用中文回答'), '同对话首轮应注入静默记忆');

  const second = request('再聊聊', 'session-a', 'msg-2');
  assert.ok(!second.includes('始终使用中文回答'), '同一对话后续轮次不重复注入');

  // 新对话页地址栏已无 session id，此时发出的首条请求不应继承旧对话的注入记录。
  setPath('/a/chat');
  const newChat = request('新问题', null, null);
  assert.ok(newChat.includes('始终使用中文回答'), '新对话应重新注入静默记忆');
  setPath('/a/chat/s/session-a');
});

test('新对话不会回放上一轮续聊 prompt', () => {
  reset({ pendingContinuationPrompt: '工具结果：记忆已保存', pendingContinuationAt: Date.now() });
  const prompt = request('无关内容', null, null);
  assert.ok(!prompt.includes('工具结果：记忆已保存'), '新对话不应被续聊 prompt 覆盖');
  assert.ok(prompt.includes('无关内容'));
});

test('同一对话的紧接着请求仍会消费续聊 prompt', () => {
  reset({ pendingContinuationPrompt: '工具结果：记忆已保存', pendingContinuationAt: Date.now() });
  const prompt = request('继续', 'session-a', 'msg-9');
  assert.equal(prompt, '工具结果：记忆已保存');
});

test('过期的续聊 prompt 被丢弃', () => {
  reset({ pendingContinuationPrompt: '过期的工具结果', pendingContinuationAt: Date.now() - 60_000 });
  const prompt = request('继续', 'session-a', 'msg-10');
  assert.ok(!prompt.includes('过期的工具结果'));
});

// ─── 「已注入」标记的对话隔离（# 弹窗禁选串台） ───────────────────────

test('新对话页不继承上一对话的「已注入」记录（旧记忆可重新选择）', () => {
  reset();
  setPath('/a/chat/s/session-a');
  request('#全局偏好 你好', 'session-a', 'msg-1');
  assert.ok(getInjectedMemoryIdsForContext().includes(1), '当前对话应记录已注入');

  // SPA 切到新对话页：尚未发请求，地址栏已无 session id。
  setPath('/a/chat');
  assert.deepEqual(getInjectedMemoryIdsForContext(), [], '新对话页应为空，不能继承旧对话记录');
});

test('切换已有对话不串台，回到原对话仍保留本对话的已注入记录', () => {
  reset();
  setPath('/a/chat/s/session-a');
  request('#全局偏好 你好', 'session-a', 'msg-1');

  setPath('/a/chat/s/session-b');
  assert.deepEqual(getInjectedMemoryIdsForContext(), [], '不同对话之间注入记录隔离');

  setPath('/a/chat/s/session-a');
  assert.ok(getInjectedMemoryIdsForContext().includes(1), '按会话持久化，回到原对话仍可见');
});
