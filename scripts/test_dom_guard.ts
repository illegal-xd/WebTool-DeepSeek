/**
 * 运行方式（值导入不带 .ts 扩展，需先打包）：
 *   npx esbuild scripts/test_dom_guard.ts --bundle --platform=node --format=esm \
 *     --external:node:test --external:node:assert --outfile=/tmp/vc-test-dom.mjs && node /tmp/vc-test-dom.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

function makeElement() {
  return { id: '', textContent: '', style: {}, appendChild() {}, addEventListener() {} };
}

function stubDocument(head: unknown, documentElement: unknown) {
  (globalThis as unknown as { document: unknown }).document = {
    head,
    documentElement,
    getElementById: () => null,
    createElement: () => makeElement(),
    addEventListener: () => {},
  };
}

const { injectStyleElement } = await import('../core/ui/popup-common.ts');

test('document_start（head 与 documentElement 均为 null）不抛异常', () => {
  stubDocument(null, null);
  assert.doesNotThrow(() => injectStyleElement('guard-test', '.x{}'));
});

test('head 为 null 但 documentElement 可用时注入到 documentElement', () => {
  const appended: unknown[] = [];
  const root = { ...makeElement(), appendChild: (el: unknown) => appended.push(el) };
  stubDocument(null, root);
  injectStyleElement('guard-test-2', '.y{}');
  assert.equal(appended.length, 1);
});

test('head 正常时注入到 head', () => {
  const appended: unknown[] = [];
  const head = { ...makeElement(), appendChild: (el: unknown) => appended.push(el) };
  stubDocument(head, null);
  injectStyleElement('guard-test-3', '.z{}');
  assert.equal(appended.length, 1);
});
