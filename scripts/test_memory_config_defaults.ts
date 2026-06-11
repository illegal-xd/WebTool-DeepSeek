import assert from 'node:assert/strict';
import { DEFAULT_CUSTOM_MEMORY_PROMPT, normalizeMemoryConfig } from '../core/memory/config.ts';

assert.match(DEFAULT_CUSTOM_MEMORY_PROMPT, /你是用户的私人 AI 助手/);
assert.match(DEFAULT_CUSTOM_MEMORY_PROMPT, /\{\{memories\}\}/);
assert.match(DEFAULT_CUSTOM_MEMORY_PROMPT, /\{\{tools\}\}/);

assert.equal(
  normalizeMemoryConfig({ tokenBudget: 3000, singleMemoryInjection: false, customMemoryEnabled: true }).customMemoryPrompt,
  DEFAULT_CUSTOM_MEMORY_PROMPT,
);

assert.equal(
  normalizeMemoryConfig({ tokenBudget: 3000, singleMemoryInjection: false, customMemoryEnabled: true, customMemoryPrompt: '' }).customMemoryPrompt,
  DEFAULT_CUSTOM_MEMORY_PROMPT,
);

assert.equal(
  normalizeMemoryConfig({ tokenBudget: 3000, singleMemoryInjection: false, customMemoryEnabled: true, customMemoryPrompt: '自定义' }).customMemoryPrompt,
  '自定义',
);

console.log('ok - memory config defaults custom prompt to system prompt');
