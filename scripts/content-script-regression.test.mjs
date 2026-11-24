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

test('发送按钮只在输入框容器内按语义查找，绝不全局猜按钮', () => {
  const functionSource = source.match(/function findSendButton\(textarea: HTMLTextAreaElement\): HTMLElement \| null \{[\s\S]*?\n\}/)?.[0];

  assert.ok(functionSource, 'findSendButton must exist');
  assert.match(functionSource, /textarea\.parentElement/, '应以输入框为起点向上找容器');
  assert.match(functionSource, /closest<HTMLElement>\(['"]button, \[role="button"\]['"]\)/, '命中 SVG 时要解析成真实可点击元素');
  assert.doesNotMatch(source, /div\[role="button"\] > div > svg/, '不得再用全局通用结构选择器猜按钮');
  assert.match(source, /const sent = await fillAndSendPrompt\(CONTINUATION_MARKER\)/, '续聊必须使用共享的占位标记');
});

test('memory_get 结果自动续聊，但「只查看记忆」时跳过', () => {
  assert.match(source, /const MEMORY_READ_TOOL_NAMES = new Set\(\[/, '应定义只读记忆工具集合');
  assert.match(source, /function isMemoryReadToolName\(name: string\): boolean/);
  assert.match(source, /function isViewOnlyPrompt\(prompt: string\): boolean/);
  const guard = source.match(/const viewOnlyMemoryRead = [\s\S]*?isViewOnlyPrompt\(lastUserPrompt\);/)?.[0];
  assert.ok(guard, '应存在「只读记忆 + 只看意图」短路判断');
  assert.match(guard, /currentTurnToolNames\.every\(isMemoryReadToolName\)/);
  assert.match(source, /if \(viewOnlyMemoryRead\) \{[\s\S]*?continuationRound = 0;/);
});

test('工具调用过多时工具块内部滚动，不裁掉内容', () => {
  const bodyCss = source.match(/\.dpp-tb-body \{[\s\S]*?\n\}/)?.[0];
  assert.ok(bodyCss, '.dpp-tb-body 样式必须存在');
  assert.match(bodyCss, /overflow-y: auto/);
  assert.match(bodyCss, /max-height: min\(60vh, 520px\)/);
  assert.match(bodyCss, /overscroll-behavior: contain/);
});

test('memory_get：工具卡片状态行只显示 summary，并回传已读事件', () => {
  assert.match(source, /const displayedSummary = result\.summary;/, '状态行不应再用 detail 全文');
  const exec = source.match(/async function executeToolCall\(call: ToolCall\): Promise<ToolCardResult> \{[\s\S]*?\n\}/)?.[0];
  assert.ok(exec, 'executeToolCall 必须存在');
  assert.match(exec, /call\.name === 'memory_get' && resolved\.ok/);
  assert.match(exec, /type: 'MEMORY_CONTENT_READ'/);
});

test('工具状态行在实时/恢复两条路径都只显示 summary 或标题', () => {
  assert.doesNotMatch(
    source,
    /createToolBlockItem\(getToolDisplayName\(call\.name\), result\.detail \|\| result\.summary/,
    '实时新增条目不应把 detail 当状态行',
  );
  assert.match(source, /createToolBlockItem\(getToolDisplayName\(call\.name\), result\.summary/);
  assert.match(source, /resolveRestoredStatus\(exec\)/, '恢复渲染必须走状态文本归一');

  const helper = source.match(/function resolveRestoredStatus\(exec: ToolExecutionRecord\): string \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, 'resolveRestoredStatus 必须存在');
  assert.match(helper, /summary === detailText/, '旧记录（summary 存了全文）需识别');
  assert.match(helper, /\(\.\+\)/, '旧记录应从 detail 首行提取标题');
  assert.match(helper, /summary\.length > 120/, '长摘要需截断');
});
