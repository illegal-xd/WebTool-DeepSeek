/**
 * DeepSeek 账号安全回归：约束「自动发消息 / 私有接口连发 / 重复执行」三类风险。
 * 断言基于源码文本（与仓库既有回归测试风格一致），防止这些约束被无意改回。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const contentSource = read('entrypoints/content.ts');
const mainWorldSource = read('entrypoints/main-world.content.ts');
const backgroundSource = read('entrypoints/background.ts');
const fetchHookSource = read('core/interceptor/fetch-hook.ts');
const sseParserSource = read('core/interceptor/sse-parser.ts');
const apiSource = read('core/conversation/api.ts');
const configSource = read('core/memory/config.ts');
const conversationPageSource = read('entrypoints/sidepanel/pages/ConversationPage.tsx');
const constantsSource = read('core/constants.ts');

test('自动续聊默认关闭，且每条消息最多 2 轮', () => {
  assert.match(configSource, /autoContinueEnabled: false/, '配置默认必须是关闭');
  assert.match(contentSource, /const MAX_CONTINUATION_ROUNDS = 2;/, '续聊轮数上限应为 2');
  assert.match(contentSource, /let autoContinueEnabled = false;/, '内容脚本默认关闭续聊');
});

test('中断或请求失败时不自动续聊', () => {
  assert.match(contentSource, /async function finalizeResponse\(meta\?: \{ aborted\?: boolean \}\)/, 'finalize 需要接收中断标记');
  assert.match(contentSource, /meta\?\.aborted === true \|\| !autoContinueEnabled/, '中断/关闭开关时必须短路');
  assert.match(contentSource, /await finalizeResponse\(\{ aborted: event\.data\.aborted === true \}\)/, '中断标记要传进 finalize');
  assert.match(fetchHookSource, /let aborted = response\.ok === false;/, '请求失败视为中断');
  assert.match(fetchHookSource, /aborted = true;\s*\n\s*finalizeIfNeeded\(\);/, '流读取异常要标记中断');
  assert.match(fetchHookSource, /const failed = aborted \|\| xhr\.status >= 400;/, 'XHR 失败也要标记中断');
  assert.match(fetchHookSource, /hookState\.onResponseComplete\(fullText, \{ aborted: failed \}\);/, 'XHR 中断标记要传给上层');
});

test('续聊内容只替换占位标记请求，绝不顶替用户输入', () => {
  assert.match(constantsSource, /export const CONTINUATION_MARKER = '继续';/);
  assert.match(fetchHookSource, /const isContinuationMarker = rawPrompt\.trim\(\) === CONTINUATION_MARKER;/, '替换前必须校验占位标记');
  assert.match(fetchHookSource, /fresh && isContinuationMarker && !isNewConversation/, '三个条件必须同时满足');
  assert.match(fetchHookSource, /const CONTINUATION_PROMPT_TTL_MS = 10_000;/, '挂起 prompt 有效期应缩短到 10s');
  assert.match(
    contentSource,
    /const sent = await fillAndSendPrompt\(CONTINUATION_MARKER\);\s*\n\s*if \(sent\) return;/,
    '发送失败后必须有收尾分支',
  );
  assert.match(contentSource, /function clearPendingContinuation\(\)/, '需要显式丢弃挂起 prompt');
});

test('工具调用按指纹 + 序号去重，不按数组下标', () => {
  assert.match(fetchHookSource, /function toolCallFingerprint\(call: ToolCall\): string/);
  assert.match(fetchHookSource, /function notifyNewToolCalls\(fullText: string, notified: Set<string>\): void/);
  assert.match(fetchHookSource, /const ordinal = \(occurrences\.get\(fingerprint\) \?\? 0\) \+ 1;/, '同一 DSML 块内的兄弟调用要按序号区分，否则第二条会被吞');
  assert.match(fetchHookSource, /const notifiedCalls = new Set<string>\(\);/, '每个响应使用独立指纹集合');
  assert.doesNotMatch(fetchHookSource, /notifiedCount/, '不得残留按下标去重的实现');
});

test('发送失败不重置轮次计数，且清掉输入框残留', () => {
  const trigger = contentSource.match(/async function triggerAutoContinue\(prompt: string\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(trigger, 'triggerAutoContinue 必须存在');
  assert.doesNotMatch(trigger, /continuationRound = 0;/, '失败分支清零会让 2 轮上限被无限续命');
  assert.match(contentSource, /if \(textarea\.value\.trim\(\) === text\.trim\(\)\) \{/, '失败时要清掉残留的占位文本');
});

test('续聊发送前有随机人类级延迟，且切会话/用户插话/关开关会放弃', () => {
  assert.match(contentSource, /2000 \+ Math\.random\(\) \* 3000/, '发送前应有 2–5s 随机延迟');
  assert.match(contentSource, /\|\| turnSeq !== turnSeqBeforeWait/, '等待期间用户插话也要放弃');
  assert.match(contentSource, /if \(autoContinueEnabled && !enabled\)/, '关闭开关时要作废挂起的续聊');
});

test('中断/失败时不执行流里残留的工具调用', () => {
  assert.match(fetchHookSource, /if \(!aborted\) notifyNewToolCalls\(fullText, notifiedCalls\);/, 'fetch 中断时不得执行');
  assert.match(fetchHookSource, /if \(!failed\) notifyNewToolCalls\(fullText, notifiedCalls\);/, 'XHR 中断/失败时不得执行');
});

test('会话列表截断有提示，批量操作有上限', () => {
  assert.match(apiSource, /export function getLastSessionListTruncated\(\): boolean/);
  assert.match(apiSource, /lastSessionListTruncated = truncated;/, '要记录截断状态');
  assert.match(contentSource, /truncated: getLastSessionListTruncated\(\)/, '列表响应要带上截断标记');
  assert.match(backgroundSource, /const MAX_BULK_SESSION_OPERATIONS = 50;/, '后台要有批量上限');
  assert.match(conversationPageSource, /const MAX_BULK_SESSION_OPERATIONS = 50;/, 'UI 要有批量上限');
  assert.match(conversationPageSource, /\{truncated && \(/, 'UI 要显示截断提示');
  assert.match(apiSource, /const gap = API_MIN_INTERVAL_MS \+ Math\.random\(\) \* API_JITTER_MS;/, '节流要有随机抖动');
});

test('切对话与页面桥接的边界处理', () => {
  assert.match(contentSource, /clearPendingContinuation\(\);\s*\n\s*isAutoContinuing = false;\s*\n\s*markRouteRestoreWindow\(\);/, '切换对话要作废挂起续聊');
  assert.match(contentSource, /if \(event\.source && event\.source !== window\) return;/, '内容脚本要拒绝其它 window 来源');
  assert.match(mainWorldSource, /if \(event\.source && event\.source !== window\) return;/, '页面世界桥接要拒绝其它 window 来源');
});

test('改名/删除同步会话缓存，避免侧边栏显示旧值', () => {
  assert.match(backgroundSource, /async function patchConversationSessionCache/);
  assert.match(backgroundSource, /session\.id === id \? \{ \.\.\.session, title \} : session/, '改名要写回缓存');
  assert.match(backgroundSource, /sessions\.filter\(\(session\) => !removed\.has\(session\.id\)\)/, '删除要写回缓存');
});

test('SSE 正文提取排除思考路径与状态事件', () => {
  assert.match(sseParserSource, /function isReasoningPath\(path: unknown\): boolean/);
  assert.match(sseParserSource, /const NON_CONTENT_FRAGMENT_TYPES = new Set\(/);
  assert.match(sseParserSource, /if \(isReasoningPath\(parsed\.p\)\) return null;/, '思考内容不得进入工具解析');
  assert.match(sseParserSource, /if \(parsed\.p === undefined \|\| isContentPath\(parsed\.p\)\) return parsed\.v;/, '状态事件不得当作正文');
});

test('fetch hook 安装幂等', () => {
  assert.match(fetchHookSource, /const HOOK_INSTALLED_FLAG = /);
  assert.match(fetchHookSource, /if \(scope\[HOOK_INSTALLED_FLAG\] === true\) return;/, '重复安装必须直接返回');
});

test('私有 Web 接口统一节流、分页有上限、版本号不写死', () => {
  assert.match(apiSource, /const API_MIN_INTERVAL_MS = 600;/);
  assert.match(apiSource, /await waitForApiSlot\(\);/, '所有请求必须排队');
  assert.match(apiSource, /let apiQueue: Promise<void> = Promise\.resolve\(\);/, '节流必须是 FIFO 队列，不能靠时间戳推测');
  assert.match(apiSource, /const MAX_SESSION_PAGES = 20;/, '分页上限应为 20');
  assert.doesNotMatch(apiSource, /safety < 100/, '不得再出现 100 页翻页');
  assert.match(apiSource, /function getAppVersion\(\): string/, '版本号要从页面请求里取');
  assert.doesNotMatch(apiSource, /'X-App-Version': '2\.0\.0'/, '不得硬编码版本号到请求头');
});

test('重命名对话不再强制整页 reload', () => {
  assert.doesNotMatch(conversationPageSource, /REFRESH_DEEPSEEK_PAGE/, '改名不应触发页面重载');
});
