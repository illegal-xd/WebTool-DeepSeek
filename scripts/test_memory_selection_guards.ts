import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens, formatMemoriesBlock, keywordScore, selectMemories, segmentText } from '../core/memory/selector.ts';
import { MEMORY_KEYWORD_MAX_HITS, MEMORY_SINGLE_ENTRY_MAX_RATIO } from '../core/constants.ts';
import type { Memory } from '../core/types.ts';

const PROMPT = '帮我看看这个项目的记忆注入链路有没有问题';

function makeMemory(id: number, content: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    syncId: `m-${id}`,
    type: 'topic',
    scope: 'contextual',
    name: `记忆${id}`,
    content,
    tags: [],
    pinned: false,
    accessCount: 0,
    lastAccessedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const shortContent = '项目记忆注入链路正常。';
const longContent = ('记忆内容片段：' + shortContent).repeat(200); // ≈6k 字符长文档

test('关键词计分饱和：长文本不再按词频无界累加', () => {
  const words = segmentText(PROMPT);
  const shortScore = keywordScore(words, makeMemory(1, shortContent));
  const longScore = keywordScore(words, makeMemory(2, longContent));

  assert.ok(shortScore > 0, '短记忆应获得关键词分');
  const hardCap =
    MEMORY_KEYWORD_MAX_HITS.tag * 20 +
    MEMORY_KEYWORD_MAX_HITS.name * 15 +
    MEMORY_KEYWORD_MAX_HITS.content * 5;
  assert.ok(longScore <= hardCap, `长记忆得分应饱和在 ${hardCap} 以内，实际 ${longScore}`);
  // 修复前同主题长文可达 +6000；饱和后与短记忆的差距应受控
  assert.ok(longScore - shortScore < 300, `长短记忆得分差应受控，实际 ${longScore - shortScore}`);
});

test('单条超大记忆不参与注入（不再撑爆预算）', () => {
  const giant = makeMemory(999, '长文档'.repeat(4000)); // ≈12k 字符
  const single = selectMemories(PROMPT, [giant], { budget: 3000 });
  assert.equal(single.length, 0, '唯一且超上限的记忆应被跳过');

  const smalls = Array.from({ length: 5 }, (_, i) => makeMemory(i + 1, shortContent + i));
  const pool = [makeMemory(1000, '长文档'.repeat(4000), { pinned: true }), ...smalls];
  const selected = selectMemories(PROMPT, pool, { budget: 3000 });

  assert.ok(!selected.some((memory) => memory.id === 1000), '超上限的置顶记忆应被跳过');
  assert.equal(selected.length, smalls.length, '常规记忆应正常命中');
  assert.ok(
    estimateTokens(formatMemoriesBlock(selected)) <= 3000,
    '注入总量必须落在预算内',
  );
});

test('单条上限按预算比例生效', () => {
  const cap = Math.floor(3000 * MEMORY_SINGLE_ENTRY_MAX_RATIO); // 1500
  const oversized = makeMemory(5, 'x'.repeat(Math.ceil((cap + 200) / 0.35)));
  assert.equal(selectMemories(PROMPT, [oversized], { budget: 3000 }).length, 0);

  const fitting = makeMemory(6, '项目记忆注入链路正常 '.repeat(40)); // ≈ 700 tok < cap
  assert.equal(selectMemories(PROMPT, [fitting], { budget: 3000 }).length, 1);
});
