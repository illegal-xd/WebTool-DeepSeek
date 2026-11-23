import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePresetMention } from '../core/preset/mention.ts';
import type { SystemPromptPreset } from '../core/types.ts';

function preset(name: string, overrides: Partial<SystemPromptPreset> = {}): SystemPromptPreset {
  return { id: `id-${name}`, name, content: `${name} 的内容`, createdAt: 0, updatedAt: 0, ...overrides };
}

test('片段模式（insertOnly）预设不参与 @mention 注入', () => {
  const snippet = preset('周报模板', { insertOnly: true });
  const inject = preset('严谨模式');
  assert.equal(
    resolvePresetMention('@周报模板 本周进展', [snippet, inject]),
    null,
    '片段内容由 popup 写入正文，不应再被解析为注入指令',
  );
  assert.equal(
    resolvePresetMention('@严谨模式 本周进展', [snippet, inject])?.preset.name,
    '严谨模式',
  );
});

test('同名的注入预设与片段预设并存时，注入预设仍可命中', () => {
  const inject = preset('写作');
  const snippet = preset('写作', { id: 'snippet', insertOnly: true });
  assert.equal(resolvePresetMention('@写作 开始', [inject, snippet])?.preset.id, 'id-写作');
});
