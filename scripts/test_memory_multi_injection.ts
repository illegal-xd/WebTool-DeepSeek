/**
 * 运行方式（值导入不带 .ts 扩展，需先打包）：
 *   npx esbuild scripts/test_memory_multi_injection.ts --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --outfile=/tmp/vc-test-multi.mjs && node /tmp/vc-test-multi.mjs
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
  location: { pathname: '/a/chat/s/s1', href: 'https://chat.deepseek.com/a/chat/s/s1' },
  localStorage: { getItem: () => null },
};

const { updateHookState, modifyRequestBody } = await import('../core/interceptor/fetch-hook.ts');
const { DEFAULT_TOOL_DESCRIPTORS } = await import('../core/tool/index.ts');

function memory(id: number, name: string, content: string) {
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
  };
}

const memories = [memory(1, '项目背景', '负责支付网关重构'), memory(2, '技术栈', '使用 pnpm 管理依赖')];

function buildPrompt(prompt: string): string {
  updateHookState({ memories, toolDescriptors: [...DEFAULT_TOOL_DESCRIPTORS], customMemoryEnabled: false });
  const out = modifyRequestBody(JSON.stringify({
    prompt,
    chat_session_id: 's1',
    parent_message_id: null,
    thinking_enabled: false,
  }));
  assert.ok(out, 'modifyRequestBody 不应返回 null');
  return JSON.parse(out).prompt as string;
}

test('单条 #记忆 注入保持原有行为', () => {
  const prompt = buildPrompt('#项目背景 帮我看下设计');
  assert.ok(prompt.includes('负责支付网关重构'));
  assert.ok(!prompt.includes('pnpm 管理依赖'));
  assert.ok(prompt.includes('帮我看下设计'));
});

test('多选注入：#记忆A #记忆B 正文 一次性带上两条内容', () => {
  const prompt = buildPrompt('#项目背景 #技术栈 帮我评估方案');
  assert.ok(prompt.includes('负责支付网关重构'), '应包含第一条记忆');
  assert.ok(prompt.includes('pnpm 管理依赖'), '应包含第二条记忆');
  assert.ok(prompt.includes('帮我评估方案'), '用户正文应保留');
});

test('重复与顺序无关：同一条记忆写两次只注入一次', () => {
  const prompt = buildPrompt('#技术栈 #技术栈 评估');
  const occurrences = prompt.split('使用 pnpm 管理依赖').length - 1;
  assert.equal(occurrences, 1);
});

test('未命中的 # 文本不触发手动注入路径（原文本保留）', () => {
  // 未命中记忆时走普通自动注入，`#...` 只是普通正文，不会被剥离。
  const prompt = buildPrompt('#不存在的记忆 你好');
  assert.ok(prompt.includes('#不存在的记忆'));
});

test('注入过的记忆会记录为「上下文已注入」，供弹窗禁用重复选择', async () => {
  const { getInjectedMemoryIdsForContext } = await import('../core/interceptor/fetch-hook.ts');
  buildPrompt('#项目背景 你好');
  assert.ok(getInjectedMemoryIdsForContext().includes(1), '注入后应记录该记忆 id');
});

test('多选注入会记录全部已注入记忆', async () => {
  const { getInjectedMemoryIdsForContext } = await import('../core/interceptor/fetch-hook.ts');
  buildPrompt('#项目背景 #技术栈 再问一次');
  const ids = getInjectedMemoryIdsForContext();
  assert.ok(ids.includes(1) && ids.includes(2));
});

test('静默注入的记忆在首轮请求中被自动注入（无需 # 选择）', () => {
  const silent = { ...memory(3, '输出语言', '始终使用中文回答'), silentInject: true };
  updateHookState({
    memories: [...memories, silent],
    toolDescriptors: [...DEFAULT_TOOL_DESCRIPTORS],
    customMemoryEnabled: false,
  });
  const out = modifyRequestBody(JSON.stringify({
    prompt: '完全无关的问题',
    chat_session_id: 's-silent',
    parent_message_id: null,
    thinking_enabled: false,
  }));
  assert.ok(out);
  const prompt = JSON.parse(out).prompt as string;
  assert.ok(prompt.includes('始终使用中文回答'), '静默记忆应出现在首轮注入内容中');
});

test('Expert 模式已停用：即使残留配置也不再覆盖请求体 model_type', () => {
  updateHookState({
    memories,
    toolDescriptors: [...DEFAULT_TOOL_DESCRIPTORS],
    modelType: 'expert' as never,
    customMemoryEnabled: false,
  });
  const out = modifyRequestBody(JSON.stringify({
    prompt: '你好',
    chat_session_id: 's-expert',
    parent_message_id: null,
    thinking_enabled: false,
  }));
  assert.ok(out);
  const body = JSON.parse(out) as Record<string, unknown>;
  assert.equal('model_type' in body, false, '不应再写入 model_type');
});
