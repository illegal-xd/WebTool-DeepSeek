/**
 * 运行方式（值导入不带 .ts 扩展，需先打包）：
 *   npx esbuild scripts/test_memory_capture_and_health.ts --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --outfile=/tmp/vc-test-memory.mjs && node /tmp/vc-test-memory.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMemoryCandidates } from '../core/memory/extractor.ts';
import { computeMemoryHealth, findDuplicateMemories, textSimilarity } from '../core/memory/health.ts';
import { planMemoryInjection } from '../core/memory/plan.ts';
import type { Memory } from '../core/types.ts';

function memory(id: number, name: string, content: string, scope: Memory['scope'] = 'permanent'): Memory {
  return {
    id,
    syncId: `s-${id}`,
    type: 'user',
    scope,
    name,
    content,
    tags: [],
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    accessCount: 0,
    lastAccessedAt: 0,
  };
}

test('提炼「记住」类显式指令为候选', () => {
  const { candidates } = extractMemoryCandidates('请记住：我负责支付网关的重构');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'user');
  assert.equal(candidates[0].scope, 'permanent');
  assert.equal(candidates[0].status, 'pending', '候选必须等待用户确认');
  assert.match(candidates[0].content, /支付网关/);
});

test('提炼长期偏好与项目上下文，且疑问句被拒绝', () => {
  const liking = extractMemoryCandidates('我习惯用 pnpm 管理依赖').candidates;
  assert.equal(liking.length, 1);
  assert.equal(liking[0].type, 'user');

  const project = extractMemoryCandidates('我们现在在做 DeepSeek 插件').candidates;
  assert.equal(project.length, 1);
  assert.equal(project[0].scope, 'contextual');

  const question = extractMemoryCandidates('我喜欢什么？');
  assert.equal(question.candidates.length, 0);
  assert.ok(question.rejected >= 1);
});

test('普通对话不产生候选', () => {
  const { candidates } = extractMemoryCandidates('帮我看看这段代码为什么报错');
  assert.equal(candidates.length, 0);
});

test('计划排除会剔除指定记忆并把预算让给其他记忆', () => {
  const memories = [
    memory(1, '项目背景', '我在做 DeepSeek 浏览器插件，关注记忆注入体验'),
    memory(2, '技术栈', '使用 WXT + React + TypeScript 开发'),
  ];
  const full = planMemoryInjection('浏览器插件记忆', memories);
  assert.ok(full.items.length >= 1);

  const firstId = full.items[0].memory.id!;
  const filtered = planMemoryInjection('浏览器插件记忆', memories, { excludeIds: new Set([firstId]) });
  assert.ok(!filtered.items.some((item) => item.memory.id === firstId), '排除项不应出现在注入计划中');
});

test('近似记忆检测与体检统计', () => {
  const a = memory(1, '技术栈', '使用 WXT + React + TypeScript 开发浏览器插件');
  const b = memory(2, '技术栈', '使用 WXT + React + TypeScript 开发浏览器插件');
  const c = memory(3, '作息', '每天晚上十点后不安排会议');
  assert.ok(textSimilarity(`${a.name} ${a.content}`, `${b.name} ${b.content}`) > 0.9);

  const duplicates = findDuplicateMemories([a, b, c]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].a.id, 1);

  const health = computeMemoryHealth([a, b, c], { tokenBudget: 3000, archivedCount: 2 });
  assert.equal(health.total, 3);
  assert.equal(health.archivedCount, 2);
  assert.ok(health.injectionBudget > 0);
  assert.equal(health.duplicates.length, 1);
  assert.equal(health.scopeTokens.permanent > 0, true);
});
