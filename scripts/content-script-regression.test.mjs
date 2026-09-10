import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../entrypoints/content.ts', import.meta.url), 'utf8');

test('does not pass an empty token to classList.add', () => {
  assert.doesNotMatch(
    source,
    /classList\.add\(status\s*===\s*['"]error['"]\s*\?\s*['"]is-error['"]\s*:\s*['"]['"]\)/,
  );
});

test('send button lookup resolves an HTMLElement click target instead of an SVG', () => {
  const functionSource = source.match(/function findSendButton\(\): HTMLElement \| null \{[\s\S]*?\n\}/)?.[0];

  assert.ok(functionSource, 'findSendButton must exist');
  assert.match(functionSource, /closest<HTMLElement>\(['"]button, \[role="button"\]['"]\)/);
  assert.match(functionSource, /instanceof HTMLElement/);
});
