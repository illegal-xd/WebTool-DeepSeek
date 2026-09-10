import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePresetMention } from '../core/preset/mention.ts';
import type { SystemPromptPreset } from '../core/types.ts';

function preset(name: string): SystemPromptPreset {
  return { id: `id-${name}`, name, content: `${name} 的指令`, createdAt: 0, updatedAt: 0 };
}

// 故意把短名放在前面，验证「最长匹配」而非「首个匹配」
const presets = [preset('严谨'), preset('严谨模式'), preset('普通')];

test('解析 @预设名 mention 并返回剥离后的正文', () => {
  assert.deepEqual(resolvePresetMention('@严谨模式 帮我写代码', presets), {
    preset: presets[1],
    rest: '帮我写代码',
  });
  assert.deepEqual(resolvePresetMention('@严谨 写代码', presets), {
    preset: presets[0],
    rest: '写代码',
  });
  assert.deepEqual(resolvePresetMention('@严谨模式\n继续', presets), {
    preset: presets[1],
    rest: '继续',
  });
  assert.deepEqual(resolvePresetMention('@普通 你好', presets), {
    preset: presets[2],
    rest: '你好',
  });
});

test('互为前缀时取最长匹配', () => {
  const result = resolvePresetMention('@严谨模式测试一下', presets);
  assert.equal(result, null, '「严谨模式测试一下」边界不符，不应命中任一名');

  const exact = resolvePresetMention('@严谨模式 测试', presets);
  assert.equal(exact?.preset.name, '严谨模式');
});

test('纯 mention / 边界不符 / 无匹配时不触发', () => {
  assert.equal(resolvePresetMention('@严谨模式', presets), null);
  assert.equal(resolvePresetMention('@严谨模式   ', presets), null);
  assert.equal(resolvePresetMention('@严谨模式abc 正文', presets), null);
  assert.equal(resolvePresetMention('@不存在 正文', presets), null);
  assert.equal(resolvePresetMention('普通正文', presets), null);
  assert.equal(resolvePresetMention('邮箱 me@严谨 结尾', presets), null);
  assert.equal(resolvePresetMention('', presets), null);
});

test('预设列表为空时不触发', () => {
  assert.equal(resolvePresetMention('@严谨模式 正文', []), null);
});
