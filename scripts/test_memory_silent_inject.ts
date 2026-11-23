/**
 * 运行方式（值导入不带 .ts 扩展，需先打包）：
 *   npx esbuild scripts/test_memory_silent_inject.ts --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --outfile=/tmp/vc-test-silent.mjs && node /tmp/vc-test-silent.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMemories } from '../core/memory/selector.ts';
import type { Memory } from '../core/types.ts';

function memory(id: number, name: string, content: string, silentInject = false): Memory {
  return {
    id,
    syncId: `s-${id}`,
    type: 'user',
    scope: 'permanent',
    name,
    content,
    tags: [],
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    accessCount: 0,
    lastAccessedAt: 0,
    silentInject,
  };
}

test('静默注入的记忆即使零关键词命中也会入选', () => {
  const silent = memory(1, '输出语言', '始终使用中文回答', true);
  const unrelated = memory(2, '股票分析', '分析银行股估值的方法');
  const selected = selectMemories('今天天气怎么样', [silent, unrelated]);
  assert.ok(selected.some((item) => item.id === 1), '静默记忆应被强制注入');
});

test('静默记忆优先于同层级的高权重记忆', () => {
  const normal = memory(1, '股票分析', '分析银行股估值的方法');
  const silent = memory(2, '输出语言', '始终使用中文回答', true);
  const selected = selectMemories('股票 分析', [normal, silent]);
  assert.equal(selected[0]?.id, 2, '静默记忆应排在首位');
});

test('未开启静默注入时仍按关键词相关性排序', () => {
  const hit = memory(1, '天气', '今天天气晴朗适合出行');
  const unrelated = memory(3, '输出语言', '始终使用中文回答', false);
  const selected = selectMemories('今天天气怎么样', [unrelated, hit]);
  assert.equal(selected[0]?.id, 1, '命中关键词的记忆应排在非静默记忆之前');
});

test('多条静默记忆都会入选', () => {
  const a = memory(1, '语言', '始终使用中文回答', true);
  const b = memory(2, '风格', '回答尽量简洁', true);
  const selected = selectMemories('随便聊聊', [a, b]);
  assert.ok(selected.some((item) => item.id === 1));
  assert.ok(selected.some((item) => item.id === 2));
});
