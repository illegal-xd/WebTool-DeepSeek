/**
 * 运行方式（值导入不带 .ts 扩展，需先打包）：
 *   npx esbuild scripts/test_memory_auto_inject.ts --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --outfile=/tmp/vc-test-auto-inject.mjs && node /tmp/vc-test-auto-inject.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// fetch-hook 依赖浏览器全局，先补齐最小实现再动态导入。
const sessionStore = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  sessionStorage: {
    getItem: (key: string) => sessionStore.get(key) ?? null,
    setItem: (key: string, value: string) => { sessionStore.set(key, value); },
  },
  location: { pathname: '/a/chat/s/s-auto', href: 'https://chat.deepseek.com/a/chat/s/s-auto' },
  localStorage: { getItem: () => null },
};

const { updateHookState, modifyRequestBody, getInjectedMemoryIdsForContext, recordMemoryToolRead } = await import('../core/interceptor/fetch-hook.ts');
const { DEFAULT_TOOL_DESCRIPTORS } = await import('../core/tool/index.ts');
const { executeMemoryToolCall } = await import('../core/tool/memory.ts');

function memory(id: number, name: string, content: string, silentInject = false, tags: string[] = []) {
  return {
    id,
    syncId: `s-${id}`,
    type: 'user' as const,
    scope: 'permanent' as const,
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

function inject(prompt: string, chatSessionId: string | null, parentMessageId: string | null): string {
  const out = modifyRequestBody(JSON.stringify({
    prompt,
    chat_session_id: chatSessionId,
    parent_message_id: parentMessageId,
    thinking_enabled: false,
  }));
  assert.ok(out, 'modifyRequestBody 不应返回 null');
  return JSON.parse(out).prompt as string;
}

updateHookState({
  memories: [
    memory(1, '输出语言', '始终使用中文回答', true, ['语言']),
    memory(2, '项目背景', '负责支付网关重构', false, ['项目', '支付']),
  ],
  toolDescriptors: [...DEFAULT_TOOL_DESCRIPTORS],
  customMemoryEnabled: false,
  pendingContinuationPrompt: null,
  pendingContinuationAt: 0,
});

test('首轮：静默记忆标注（全文）并注入正文，普通记忆标注（仅标题）', () => {
  const prompt = inject('获取记忆列表', 's-auto', null);

  assert.match(prompt, /#1 \[user\] 输出语言（全文）: 始终使用中文回答/, '静默记忆应标注全文并带正文');
  assert.match(prompt, /#2 \[user\] 项目背景（仅标题）/, '普通记忆应标注仅标题');
  assert.doesNotMatch(prompt, /tags:/, '注入行不再输出标签，精简上下文');
  assert.doesNotMatch(prompt, /负责支付网关重构/, '普通记忆正文不应出现在首轮注入');

  // 索引注入不算「内容已注入」：普通记忆仍可在 # 弹窗中选择。
  const injected = getInjectedMemoryIdsForContext();
  assert.ok(injected.includes(1), '静默记忆全文进入上下文，应标记已注入');
  assert.ok(!injected.includes(2), '只有索引的普通记忆不应被标记为已注入');
});

test('同一对话后续轮次不重复注入已出现过的记忆索引', () => {
  const prompt = inject('再问一句', 's-auto', 'msg-1');
  assert.doesNotMatch(prompt, /#2 \[user\] 项目背景/, '已索引过的记忆不应重复注入');
  assert.doesNotMatch(prompt, /负责支付网关重构/, '普通记忆正文仍不应注入');
});

test('memory_save 保存的记忆默认开启静默注入', async () => {
  const savedInputs: Array<{ silentInject?: boolean }> = [];
  const result = await executeMemoryToolCall({
    listMemories: async () => [],
    saveMemory: async (input) => {
      savedInputs.push(input);
      return { id: 7 };
    },
    getMemoryById: async () => null,
    updateMemory: async () => {},
    deleteMemory: async () => {},
  }, {
    name: 'memory_save',
    payload: { type: 'user', name: '回答偏好', content: '偏好简洁回答', tags: ['偏好'] },
    raw: '',
  });

  assert.equal(result.ok, true);
  assert.equal(savedInputs[0]?.silentInject, true, 'memory_save 应默认 silentInject=true');
});

test('显式 #记忆名 仍可手动注入普通记忆全文', () => {
  const prompt = inject('#项目背景 帮我看下架构', 's-auto', 'msg-2');
  assert.match(prompt, /负责支付网关重构/, '显式选择应注入完整正文');
});

test('memory_get 读过的记忆在下一轮补注入全文，之后不再重复', () => {
  // 模拟切换到新对话：地址栏同步变化，避免读到上一个会话的持久化注入记录。
  (globalThis as unknown as { window: { location: { pathname: string } } }).window.location.pathname = '/a/chat/s/s-read';
  const first = inject('列出记忆', 's-read', null);
  assert.match(first, /#2 \[user\] 项目背景（仅标题）/);
  assert.doesNotMatch(first, /负责支付网关重构/);

  recordMemoryToolRead('#2');

  const second = inject('好的', 's-read', 'msg-1');
  assert.match(second, /#2 \[user\] 项目背景（全文）: 负责支付网关重构/, '下一轮应补注入全文');

  const third = inject('继续', 's-read', 'msg-2');
  assert.doesNotMatch(third, /负责支付网关重构/, '补注入后不应再次重复');
});
