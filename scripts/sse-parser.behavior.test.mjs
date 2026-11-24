/**
 * SSE 正文提取的行为测试（真实输入/输出，不是源码正则）。
 * 关键约束：思考内容与状态事件不能进入 fullText——否则模型「想」过的工具标记会被当成真实调用执行。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTextFromParsed } from '../core/interceptor/sse-parser.ts';

test('思考路径不产生正文', () => {
  assert.equal(
    extractTextFromParsed({ p: 'response/thinking_content', o: 'APPEND', v: '<memory_save>{"name":"x"}</memory_save>' }),
    null,
  );
  assert.equal(extractTextFromParsed({ p: 'response/reasoning', v: 'thought' }), null);
});

test('正文追加事件被提取', () => {
  assert.equal(extractTextFromParsed({ p: 'response/content', o: 'APPEND', v: 'hello' }), 'hello');
  assert.equal(extractTextFromParsed({ v: 'legacy-no-path' }), 'legacy-no-path');
});

test('状态事件不被当成正文', () => {
  assert.equal(extractTextFromParsed({ p: 'response/status', v: 'FINISHED' }), null);
});

test('fragments 只接受 APPEND，且跳过 THINK/TIP', () => {
  assert.equal(
    extractTextFromParsed({
      p: 'response/fragments',
      o: 'APPEND',
      v: [{ type: 'THINK', content: '思考' }, { type: 'RESPONSE', content: '回答' }],
    }),
    '回答',
  );
  // SET/REPLACE 快照会整段重复累计，必须忽略
  assert.equal(extractTextFromParsed({ p: 'response/fragments', o: 'SET', v: [{ content: 'snapshot' }] }), null);
});

test('BATCH 递归取第一段正文', () => {
  assert.equal(
    extractTextFromParsed({
      o: 'BATCH',
      v: [
        { p: 'response/thinking_content', v: '想' },
        { p: 'response/content', o: 'APPEND', v: '正文' },
      ],
    }),
    '正文',
  );
});
