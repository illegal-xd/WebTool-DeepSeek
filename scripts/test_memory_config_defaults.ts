import assert from 'node:assert/strict';
import { DEFAULT_CUSTOM_MEMORY_PROMPT, normalizeMemoryConfig } from '../core/memory/config.ts';

assert.match(DEFAULT_CUSTOM_MEMORY_PROMPT, /\{\{memoryContext\}\}/);
assert.match(DEFAULT_CUSTOM_MEMORY_PROMPT, /\{\{tools\}\}/);
assert.match(DEFAULT_CUSTOM_MEMORY_PROMPT, /未注入「已知信息」不代表记忆库为空/);

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
