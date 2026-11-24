import {
  deleteDeepSeekSession,
  getDeepSeekSessionHistory,
  getLastSessionListTruncated,
  listDeepSeekSessions,
  renameDeepSeekSession,
} from '../core/conversation/api';
import { CONTINUATION_MARKER } from '../core/constants';
import { DEFAULT_RECOGNIZED_TOOL_TAGS, createToolInvocationCatalog, createXmlToolCallRegex } from '../core/tool';
import type { MemoryConfig } from '../core/memory/config';
import { THEME_QUERY, normalizeThemePreference, resolveTheme, type ResolvedTheme, type ThemePreference } from '../core/theme';
import type { BackgroundConfig, Memory, ModelType, Skill, SystemPromptPreset, ToolCall, ToolCallHistoryRecord, ToolCardResult, ToolExecutionRecord, ToolCallRestoreRecord, ToolDescriptor } from '../core/types';
import type { TemplateOverrides } from '../core/templates/overrides';
import type { InjectionEvent } from '../core/inject/events';
import { buildAutoContinuationPrompt, type ContinuationToolResult } from '../core/templates/prompts';
import { extractMemoryCandidates } from '../core/memory/extractor';

const BLOCK_CLASS = 'dpp-tool-block';
const BLOCK_STYLE_ID = 'dpp-tool-block-css';
const STORAGE_PREFIX = 'dpp_tool_exec_';
const RECOGNIZED_TOOL_TAGS = [...DEFAULT_RECOGNIZED_TOOL_TAGS];
const ROUTE_RESTORE_WINDOW_MS = 8000;
const ASSISTANT_MESSAGE_SELECTORS = [
  '[class*="message"][class*="assistant"]',
  '[class*="ds-chat-message-assistant"]',
  '[class*="ds-msg-assistant"]',
  '[data-role="assistant"]',
];
const ASSISTANT_MESSAGE_SELECTOR = ASSISTANT_MESSAGE_SELECTORS.join(',');

interface TextRemovalRange {
  start: number;
  end: number;
  tagName: string | null;
}

let currentPromptThemePreference: ThemePreference = 'system';
let nextCallId = 0;
let currentToolBlock: HTMLElement | null = null;
const earlyPlaceholderNames: string[] = [];
let currentToolDescriptors: ToolDescriptor[] = [];
const pendingToolCleanupMessages = new Set<Element>();
let toolCleanupFrame: number | null = null;

// ─── 自动续聊状态 ──────────────────────────────────────────────────
/** 本轮（当前 completion 请求）收集的工具执行结果，finalize 时用于续聊决策。 */
const currentTurnResults: ContinuationToolResult[] = [];
/** 本轮工具原始名（call.name），用于判断是否只是「只读记忆查询」。 */
const currentTurnToolNames: string[] = [];
/** 最近一次用户输入（main-world 捕获），用于区分「只查看」与「带任务」。 */
let lastUserPrompt = '';
let continuationRound = 0;
/**
 * 每条用户消息最多自动续聊 2 轮。
 * 自动连发消息与真人操作差异明显，轮数越多越像脚本；超限后交还给用户。
 */
const MAX_CONTINUATION_ROUNDS = 2;
/**
 * 自动续聊总开关（设置项，默认关闭）。
 * 关闭时工具结果只在卡片里展示，不代用户发消息。
 */
let autoContinueEnabled = false;
/** 续聊请求发送后置 true，该请求的 onResponseComplete 之前有效，用于区分手动消息。 */
let isAutoContinuing = false;
/** Track raw text of tool calls already executed by TOOL_CALL handler */
const resolvedCallRaws = new Set<string>();
const activeToolExecutions = new Set<Promise<unknown>>();
let routeRestoreUntil = 0;
let suppressToolPlaceholderUntil = 0;

/**
 * Map of callId -> { call, block, promise } for tracking tool calls
 * during SSE streaming. When EXECUTE_TOOL_CALL arrives after response
 * complete, we match by callId via postMessage round-trip.
 */
const pendingCallMap = new Map<number, {
  call: ToolCall;
  block: HTMLElement;
  callId: number;
  resolved: boolean;
}>();

type RuntimeMessage = { type: string; payload?: unknown } & Record<string, unknown>;

function isExtensionContextAvailable(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

async function safeRuntimeSendMessage<T>(message: RuntimeMessage): Promise<T | null> {
  if (!isExtensionContextAvailable()) return null;
  try {
    return await chrome.runtime.sendMessage(message) as T;
  } catch {
    return null;
  }
}

function safeRuntimeOnMessage(
  listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0],
): boolean {
  if (!isExtensionContextAvailable()) return false;
  try {
    chrome.runtime.onMessage.addListener(listener);
    return true;
  } catch {
    return false;
  }
}

async function safeStorageLocalGet(key: string): Promise<Record<string, unknown> | null> {
  if (!isExtensionContextAvailable()) return null;
  try {
    return await chrome.storage.local.get(key) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function safeStorageLocalSet(data: Record<string, unknown>): Promise<void> {
  if (!isExtensionContextAvailable()) return;
  try {
    await chrome.storage.local.set(data);
  } catch {
    // The content script may outlive the extension context during reload/update.
  }
}

/** 一次性拉取注入相关全部状态（记忆/技能/预设/模型/工具/记忆配置/模板覆盖）。 */
async function fetchAllState() {
  const [memories, skills, presets, modelType, toolDescriptors, memoryConfig, templateOverrides] = await Promise.all([
    safeRuntimeSendMessage<Memory[]>({ type: 'GET_MEMORIES' }),
    safeRuntimeSendMessage<Skill[]>({ type: 'GET_SKILLS' }),
    safeRuntimeSendMessage<SystemPromptPreset[]>({ type: 'GET_PRESETS' }),
    safeRuntimeSendMessage<ModelType>({ type: 'GET_MODEL_TYPE' }),
    safeRuntimeSendMessage<ToolDescriptor[]>({ type: 'GET_TOOL_DESCRIPTORS' }),
    safeRuntimeSendMessage<MemoryConfig>({ type: 'GET_MEMORY_CONFIG' }),
    safeRuntimeSendMessage<TemplateOverrides>({ type: 'GET_TEMPLATE_OVERRIDES' }),
  ]);
  return { memories, skills, presets, modelType, toolDescriptors, memoryConfig, templateOverrides };
}

/** 记忆配置变化时同步自动续聊开关（默认关闭）。 */
function applyAutoContinueConfig(config: MemoryConfig | null | undefined) {
  const enabled = config?.autoContinueEnabled === true;
  // 从开变关：立刻作废已挂起的续聊，否则它仍会被下一个请求消费掉。
  if (autoContinueEnabled && !enabled) {
    clearPendingContinuation();
    isAutoContinuing = false;
    continuationRound = 0;
    currentTurnResults.length = 0;
  }
  autoContinueEnabled = enabled;
}

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  runAt: 'document_start',
  async main() {
    await new Promise((r) => {
      if (document.readyState === 'complete' || document.readyState === 'interactive') r(undefined);
      else document.addEventListener('DOMContentLoaded', () => r(undefined), { once: true });
    });

    const state = await fetchAllState();
    const { memories, skills, presets, modelType, toolDescriptors, memoryConfig, templateOverrides } = state;

    currentToolDescriptors = toolDescriptors ?? [];
    applyAutoContinueConfig(memoryConfig);
    syncToMainWorld({
      memories: memories ?? [],
      skills: skills ?? [],
      presets: presets ?? [],
      modelType,
      toolDescriptors: currentToolDescriptors,
      memoryConfig: memoryConfig ?? undefined,
      templateOverrides: templateOverrides ?? undefined,
    });
    markRouteRestoreWindow();
    restorePersistedToolBlocks();

    window.addEventListener('message', async (event) => {
      // 只接受本窗口消息：排除 iframe / 其它 window 伪造的 SYNC_STATE / RESPONSE_COMPLETE。
      // event.source 在部分上下文可能取不到，此时不做否决，避免误伤同窗口桥接。
      if (event.source && event.source !== window) return;
      if (event.data?.source !== 'WebTool-DeepSeek-main') return;

      switch (event.data.type) {
        case 'TOOL_CALL': {
          const call = event.data.data as ToolCall;
          const callId = nextCallId++;
          await handleToolCall(call, callId);
          break;
        }
        case 'EXECUTE_TOOL_CALL': {
          const call = event.data.data as ToolCall;
          let result: ToolCardResult = { ok: true, summary: '已执行' };
          if (!resolvedCallRaws.has(call.raw)) {
            result = await trackToolExecution(executeToolCall(call));
            resolvedCallRaws.add(call.raw);
          }
          window.postMessage({
            source: 'WebTool-DeepSeek-content',
            type: 'TOOL_CALL_RESULT',
            data: result,
            callName: call.name,
          });
          break;
        }

        case 'TURN_START': {
          // 每个新的 completion 请求开始时重置当前工具块指针，
          // 确保该轮首个工具调用创建新块、同轮后续工具调用复用此块。
          // 不清理 pendingCallMap/resolvedCallRaws：上一轮异步执行可能仍在进行中。
          currentToolBlock = null;
          currentTurnResults.length = 0;
          currentTurnToolNames.length = 0;
          currentTurnHost = null;
          turnSeq += 1;
          earlyPlaceholderNames.length = 0;
          // 手动消息（非续聊）时重置续聊计数；续聊请求自身不清零计数。
          if (!isAutoContinuing) {
            continuationRound = 0;
          }
          break;
        }

        case 'MEMORIES_USED': {
          const ids = event.data.ids as number[];
          await safeRuntimeSendMessage({ type: 'TOUCH_MEMORIES', payload: { ids } });
          break;
        }
        case 'SKILL_USED': {
          const name = event.data.name as string;
          await safeRuntimeSendMessage({ type: 'TOUCH_USAGE', payload: { kind: 'skill', name } });
          break;
        }
        case 'RESPONSE_COMPLETE': {
          if (typeof event.data.userPrompt === 'string') lastUserPrompt = event.data.userPrompt;
          await finalizeResponse({ aborted: event.data.aborted === true });
          queueMemoryCandidates(event.data.userPrompt);
          break;
        }
        case 'RESTORE_TOOL_CALLS': {
          const records = event.data.records as ToolCallRestoreRecord[];
          const hydratedRecords = await hydrateToolCallRestoreRecords(records);
          await persistToolRestoreRecords(hydratedRecords);
          renderRestoredToolBlocks(
            hydratedRecords.filter(isCurrentChatSessionRecord),
            getToolRestoreStorageKey(),
            0,
            { allowAssistantIndexFallback: true },
          );
          break;
        }
        case 'ROUTE_CHANGED': {
          // 切换对话后，上一条对话遗留的续聊 prompt 必须作废，否则会被这条对话的首个请求消费掉。
          clearPendingContinuation();
          isAutoContinuing = false;
          markRouteRestoreWindow();
          resetRenderGuard();
          clearRenderedToolBlocks();
          setTimeout(() => restorePersistedToolBlocks(), 900);
          // 二次存活检查：历史加载的 React 重渲染可能在首次恢复后移除 block。
          setTimeout(() => {
            if (document.querySelectorAll(`.${BLOCK_CLASS}`).length === 0) {
              restorePersistedToolBlocks();
            }
          }, 2500);
          break;
        }
        case 'INJECTION_EVENT': {
          const injectionEvent = event.data.data as InjectionEvent;
          await safeRuntimeSendMessage({ type: 'RECORD_INJECTION_EVENT', payload: injectionEvent });
          break;
        }
      }
    });

    safeRuntimeSendMessage<ThemePreference>({ type: 'GET_THEME' }).then((theme) => {
      applyPromptUiTheme(normalizeThemePreference(theme));
    });

    window.matchMedia(THEME_QUERY).addEventListener('change', () => {
      if (currentPromptThemePreference === 'system') applyPromptUiTheme('system');
    });

    safeRuntimeSendMessage<BackgroundConfig | null>({ type: 'GET_BACKGROUND' }).then((cfg) => {
      applyBackground(cfg);
    });

    safeRuntimeSendMessage<MemoryConfig>({ type: 'GET_MEMORY_CONFIG' }).then((cfg) => {
      if (cfg) {
        applyAutoContinueConfig(cfg);
        window.postMessage({ source: 'WebTool-DeepSeek-content', type: 'MEMORY_CONFIG_UPDATED', ...cfg });
      }
    });

    safeRuntimeOnMessage((message) => {
      if (message.type === 'STATE_UPDATED') {
        currentToolDescriptors = message.toolDescriptors ?? [];
        syncToMainWorld({
          memories: message.memories,
          skills: message.skills,
          presets: message.presets ?? [],
          modelType: message.modelType,
          toolDescriptors: currentToolDescriptors,
        });
        // Also refresh memory config in case it was changed
        safeRuntimeSendMessage<MemoryConfig>({ type: 'GET_MEMORY_CONFIG' }).then((cfg) => {
          if (cfg) {
            applyAutoContinueConfig(cfg);
            window.postMessage({ source: 'WebTool-DeepSeek-content', type: 'MEMORY_CONFIG_UPDATED', ...cfg });
          }
        });
        cleanRenderedToolCalls();
      } else if (message.type === 'TEMPLATES_UPDATED') {
        const overrides = message.overrides as TemplateOverrides | undefined;
        window.postMessage({ source: 'WebTool-DeepSeek-content', type: 'TEMPLATES_UPDATED', overrides });
      } else if (message.type === 'MEMORY_CONFIG_UPDATED') {
        const config = message as MemoryConfig;
        if (typeof config.tokenBudget === 'number' && config.tokenBudget > 0) {
          applyAutoContinueConfig(config);
          window.postMessage({ source: 'WebTool-DeepSeek-content', type: 'MEMORY_CONFIG_UPDATED', ...config });
        }
      } else if (message.type === 'TOOL_DESCRIPTORS_UPDATED') {
        safeRuntimeSendMessage<ToolDescriptor[]>({ type: 'GET_TOOL_DESCRIPTORS' }).then((descriptors) => {
          currentToolDescriptors = descriptors ?? [];
          window.postMessage({ source: 'WebTool-DeepSeek-content', type: 'SYNC_TOOL_DESCRIPTORS', toolDescriptors: currentToolDescriptors });
          cleanRenderedToolCalls();
        });
      } else if (message.type === 'BACKGROUND_UPDATED') {
        applyBackground(message.config as BackgroundConfig | null);
      } else if (message.type === 'THEME_UPDATED') {
        applyPromptUiTheme(normalizeThemePreference(message.theme));
      }
    });

    safeRuntimeOnMessage((message, _sender, sendResponse) => {
      if (typeof message.type !== 'string' || !message.type.startsWith('DS_')) return false;
      handleConversationRequest(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    });

    setupDOMObserver();
  },
});

async function handleConversationRequest(message: { type?: string; payload?: unknown }) {
  switch (message.type) {
    case 'DS_LIST_SESSIONS': {
      const sessions = await listDeepSeekSessions();
      return { ok: true, data: sessions, truncated: getLastSessionListTruncated() };
    }
    case 'DS_DELETE_SESSION': {
      const { id } = message.payload as { id: string };
      await deleteDeepSeekSession(id);
      return { ok: true };
    }
    case 'DS_RENAME_SESSION': {
      const { id, title } = message.payload as { id: string; title: string };
      await renameDeepSeekSession(id, title);
      return { ok: true };
    }
    case 'DS_GET_SESSION_HISTORY': {
      const { id } = message.payload as { id: string };
      return { ok: true, data: await getDeepSeekSessionHistory(id) };
    }
    default:
      return undefined;
  }
}

interface MainWorldSyncPayload {
  memories: Memory[];
  skills: Skill[];
  presets: SystemPromptPreset[];
  modelType: ModelType;
  toolDescriptors: ToolDescriptor[];
  memoryConfig?: MemoryConfig;
  templateOverrides?: TemplateOverrides;
}

function syncToMainWorld(payload: MainWorldSyncPayload) {
  window.postMessage({
    source: 'WebTool-DeepSeek-content',
    type: 'SYNC_STATE',
    ...payload,
    memoryTokenBudget: payload.memoryConfig?.tokenBudget,
  });
}

/**
 * After memory creation/update/deletion, refresh the memory list
 * from background and push to main world + trigger broadcast.
 */
async function refreshMemoryList() {
  try {
    const memories = await safeRuntimeSendMessage<Memory[]>({ type: 'GET_MEMORIES' });
    if (memories) {
      window.postMessage({
        source: 'WebTool-DeepSeek-content',
        type: 'SYNC_STATE_MEMORIES',
        memories,
      });
    }
  } catch {
    // ignore
  }
}

// ─── Tool Block UI ────────────────────────────────────────────────

function injectBlockStyles() {
  if (document.getElementById(BLOCK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = BLOCK_STYLE_ID;
  style.textContent = BLOCK_CSS;
  (document.head ?? document.documentElement)?.appendChild(style);
}

function createToolBlockItem(name: string, summary: string, status?: 'done' | 'error', detail?: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'dpp-tb-item';
  item.innerHTML = `
    <div class="dpp-tb-dot-wrap">
      <span class="dpp-tb-dot"></span>
    </div>
    <div class="dpp-tb-item-text">
      <div>
        <span class="dpp-tb-item-name"></span>
        <span class="dpp-tb-item-status"></span>
      </div>
    </div>
  `;

  const dot = item.querySelector('.dpp-tb-dot') as HTMLElement | null;
  const nameEl = item.querySelector('.dpp-tb-item-name') as HTMLElement | null;
  const statusEl = item.querySelector('.dpp-tb-item-status') as HTMLElement | null;

  if (status) {
    const stateClass = status === 'done' ? 'is-done' : 'is-error';
    dot?.classList.add(stateClass);
    nameEl?.classList.add(stateClass);
    if (status === 'error') statusEl?.classList.add('is-error');
  }
  if (nameEl) nameEl.textContent = name;

  // 摘要与工具名相同/冗余（如「memory_save」vs「保存记忆」）时不重复显示。
  const redundant = summary.trim() === name || summary.trim() === '已执行' || summary.trim() === '执行中...';
  if (statusEl) statusEl.textContent = redundant ? '' : summary;

  // 有详情时挂在名称下方独立区块。
  if (detail && detail.trim()) {
    const detailEl = document.createElement('div');
    detailEl.className = 'dpp-tb-item-detail';
    detailEl.textContent = detail;
    item.querySelector('.dpp-tb-item-text')?.appendChild(detailEl);
  }

  return item;
}

function createToolBlock(call: ToolCall): HTMLElement {
  injectBlockStyles();

  const block = document.createElement('div');
  block.className = BLOCK_CLASS;
  block.setAttribute('data-collapsed', 'false');

  block.innerHTML = `
    <div class="dpp-tb-header" role="button" tabindex="0" aria-expanded="true">
      <div class="dpp-tb-header-ripple"></div>
      <span class="dpp-tb-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
      </span>
      <span class="dpp-tb-title tool-calls">工具调用</span>
      <span class="dpp-tb-chevron" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    </div>
    <div class="dpp-tb-body"></div>
  `;

  setToolBlockTitle(block, 0);

  const header = block.querySelector('.dpp-tb-header') as HTMLElement;
  header.addEventListener('click', () => toggleBlockCollapse(block));
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleBlockCollapse(block);
    }
  });

  return block;
}

function updateToolBlockWithResult(block: HTMLElement, call: ToolCall, result: ToolCardResult) {
  const callDisplayName = getToolDisplayName(call.name);
  const renderKey = callRenderKey(call);
  const items = block.querySelectorAll('.dpp-tb-item');
  let targetItem: HTMLElement | null = null;

  // 1) 优先按调用键精确匹配：同一调用只更新自己那一行。
  for (const item of items) {
    if ((item as HTMLElement).dataset.callKey === renderKey) {
      targetItem = item as HTMLElement;
      break;
    }
  }

  // 2) 兼容早期占位生成的条目（其 callKey 与正式调用不同）。
  if (!targetItem) {
    for (const item of items) {
      const nameEl = item.querySelector('.dpp-tb-item-name');
      if (nameEl && (nameEl.textContent === callDisplayName || nameEl.textContent === call.name)) {
        const statusEl = item.querySelector('.dpp-tb-item-status');
        // 以 status 文本「执行中...」或空作为未完成标记。
        if (statusEl && (statusEl.textContent === '执行中...' || statusEl.textContent === '')) {
          targetItem = item as HTMLElement;
          break;
        }
      }
    }
  }

  if (!targetItem) {
    addNewToolItem(block, call, result);
    return;
  }
  targetItem.dataset.callKey = renderKey;

  const statusEl = targetItem.querySelector('.dpp-tb-item-status') as HTMLElement | null;
  // 状态行只显示 summary（如「已读取 #89」）；完整内容在下方详情区展示，避免重复两份全文
  const displayedSummary = result.summary;
  const redundant = displayedSummary === call.name
    || displayedSummary === getToolDisplayName(call.name)
    || displayedSummary === '已执行';
  if (statusEl) {
    statusEl.textContent = redundant ? '' : displayedSummary;
    statusEl.classList.toggle('is-error', !result.ok);
  }

  const dot = targetItem.querySelector('.dpp-tb-dot') as HTMLElement | null;
  if (dot) dot.classList.add(result.ok ? 'is-done' : 'is-error');

  const nameEl = targetItem.querySelector('.dpp-tb-item-name') as HTMLElement | null;
  if (nameEl) nameEl.classList.add(result.ok ? 'is-done' : 'is-error');

  // 追加详情区块（独立可滚动），优先 detail，其次序列化 output。
  const detailText = formatToolResultDetail(result);
  if (detailText) {
    const existing = targetItem.querySelector('.dpp-tb-item-detail');
    if (existing) {
      existing.textContent = detailText;
    } else {
      const detailEl = document.createElement('div');
      detailEl.className = 'dpp-tb-item-detail';
      detailEl.textContent = detailText;
      targetItem.querySelector('.dpp-tb-item-text')?.appendChild(detailEl);
    }
  }
}

/** 格式化工具结果详情：优先 detail；失败时从 output 提取；无则空。 */
function formatToolResultDetail(result: ToolCardResult): string {
  if (result.detail) {
    if (!result.ok && looksLikeJson(result.detail)) {
      const extracted = extractReadableError(result.detail);
      if (extracted) return extracted;
    }
    return result.detail;
  }
  return '';
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function extractReadableError(jsonText: string): string | null {
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) {
      const texts = parsed
        .filter((item: unknown) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text')
        .map((item: unknown) => (item as Record<string, unknown>).text)
        .filter((text: unknown): text is string => typeof text === 'string');
      if (texts.length > 0) return texts.join('\n');
    }
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.error === 'string') return parsed.error;
      if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') return parsed.error.message;
    }
  } catch {
    /* not valid JSON */
  }
  return null;
}

function setToolBlockTitle(block: HTMLElement, count: number): void {
  const titleEl = block.querySelector('.dpp-tb-title');
  if (titleEl) titleEl.textContent = count > 1 ? `工具调用(${count})` : '工具调用';
}

function getToolBlockItemCount(block: HTMLElement): number {
  return block.querySelectorAll('.dpp-tb-item').length;
}

/** block 内是否已存在同名且未完成的 item（避免重复占位）。 */
function hasUnfinishedItemForName(block: HTMLElement, name: string): boolean {
  const displayName = getToolDisplayName(name);
  const items = block.querySelectorAll('.dpp-tb-item');
  for (const item of items) {
    const nameEl = item.querySelector('.dpp-tb-item-name');
    const dot = item.querySelector('.dpp-tb-dot');
    const isFinished = dot?.classList.contains('is-done') || dot?.classList.contains('is-error');
    if (!isFinished && (nameEl?.textContent === displayName || nameEl?.textContent === name)) return true;
  }
  return false;
}

function addNewToolItem(block: HTMLElement, call: ToolCall, result: ToolCardResult) {
  const body = block.querySelector('.dpp-tb-body');
  if (!body) return;
  // 状态行只显示 summary（如记忆标题）；完整内容进入下方详情区，避免两份全文。
  const item = createToolBlockItem(getToolDisplayName(call.name), result.summary, result.ok ? 'done' : 'error', formatToolResultDetail(result));
  item.dataset.callKey = callRenderKey(call);
  body.appendChild(item);
  setToolBlockTitle(block, getToolBlockItemCount(block));
}

function addExecutingToolItem(block: HTMLElement, call: ToolCall) {
  const body = block.querySelector('.dpp-tb-body');
  if (!body) return;
  const item = createToolBlockItem(getToolDisplayName(call.name), '执行中...');
  item.dataset.callKey = callRenderKey(call);
  body.appendChild(item);
  setToolBlockTitle(block, getToolBlockItemCount(block));
}

function renderEarlyToolPlaceholder(name: string, targetMessage?: Element) {
  const displayName = getToolDisplayName(name);
  if (earlyPlaceholderNames.includes(name)) return;

  const existingBlock = targetMessage?.querySelector<HTMLElement>(`.${BLOCK_CLASS}`) ?? null;
  const targetBlock = existingBlock
    ?? (currentToolBlock && document.contains(currentToolBlock) && (!targetMessage || targetMessage.contains(currentToolBlock))
      ? currentToolBlock
      : null);

  if (targetBlock) {
    if (!hasUnfinishedItemForName(targetBlock, name)) {
      addExecutingToolItem(targetBlock, { name: displayName, invocationName: name, payload: {}, raw: '' });
    }
    earlyPlaceholderNames.push(name);
    return;
  }

  const block = createToolBlock({ name: displayName, invocationName: name, payload: {}, raw: '' });
  addExecutingToolItem(block, { name: displayName, invocationName: name, payload: {}, raw: '' });
  currentToolBlock = block;
  earlyPlaceholderNames.push(name);

  mountToolBlock(block, targetMessage instanceof HTMLElement ? targetMessage : null);
}

function consumeEarlyPlaceholder(name: string): boolean {
  const index = earlyPlaceholderNames.indexOf(name);
  if (index === -1) return false;
  earlyPlaceholderNames.splice(index, 1);
  return true;
}

function getToolDisplayName(invocationName: string): string {
  const descriptor = currentToolDescriptors.find((item) => item.invocationName === invocationName);
  return descriptor?.title || descriptor?.name || invocationName;
}

	function toggleBlockCollapse(block: HTMLElement) {
  const collapsed = block.getAttribute('data-collapsed') === 'true';
  block.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
  block.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
}


function findAssistantMessages(): HTMLElement[] {
  for (const sel of ASSISTANT_MESSAGE_SELECTORS) {
    const found = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(isElementVisible);
    if (found.length > 0) return found;
  }
  return [];
}

function isElementVisible(el: HTMLElement): boolean {
  return el.isConnected && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function isToolBlockElement(element: Element): boolean {
  return element.classList.contains(BLOCK_CLASS);
}

function isInsideToolBlock(element: Element): boolean {
  return isToolBlockElement(element) || Boolean(element.parentElement?.closest(`.${BLOCK_CLASS}`));
}

function hasExistingToolBlock(message: Element): boolean {
  return Boolean(message.querySelector(`.${BLOCK_CLASS}`));
}

function getLastAssistantMessage(): HTMLElement | null {
  const msgs = findAssistantMessages();
  if (msgs.length === 0) return null;
  // 优先返回真正含 markdown 正文的消息，避免把占位/加载态消息当作宿主。
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].querySelector('.ds-markdown, [class*="ds-markdown"]')) return msgs[i];
  }
  return msgs[msgs.length - 1];
}

/** 思考/推理容器：工具块不应挂载到这些区域（会被折叠或替换）。 */
function isReasoningContainer(el: Element): boolean {
  return Boolean(el.closest('details, [class*="thinking"], [class*="reasoning"]'));
}

/**
 * 获取 assistant message 内的稳定内容宿主容器（React reconciliation 只替换其内部
 * markdown 子节点，不会替换宿主本身），工具块挂载到此可避免被 React 重渲染移除。
 * 参考 deepseek-pp 的 getAssistantResponseHost。
 */
function getAssistantResponseHost(message: HTMLElement): HTMLElement {
  // 优先用 DeepSeek 语义化的 assistant 主内容容器。
  const hostSelectors = [
    '.ds-assistant-message-main-content',
    '._74c0879',
    '[class*="assistant-message-main-content"]',
  ];
  for (const sel of hostSelectors) {
    const hosts = message.querySelectorAll<HTMLElement>(sel);
    for (let i = hosts.length - 1; i >= 0; i -= 1) {
      if (!isReasoningContainer(hosts[i])) return hosts[i];
    }
  }
  // 回退：markdown 容器的父元素（包裹 markdown 的 content host）。
  // 思考模式下 DeepSeek 会渲染 reasoning + answer 两个 markdown 块，
  // 取最后一个（通常为最终回答块）以避免误挂到 reasoning 容器。
  const markdowns = message.querySelectorAll<HTMLElement>('.ds-markdown, [class*="ds-markdown"]');
  const lastMarkdown = markdowns.length > 0 ? markdowns[markdowns.length - 1] : null;
  if (
    lastMarkdown?.parentElement
    && lastMarkdown.parentElement !== message
    && !isReasoningContainer(lastMarkdown.parentElement)
  ) {
    return lastMarkdown.parentElement;
  }
  // 最终回退：message root（与现状一致，不更差）。
  return message;
}

function getAssistantMessageRoot(el: Element): Element | null {
  return el.closest(ASSISTANT_MESSAGE_SELECTOR);
}

// ─── 工具块渲染守护 ───────────────────────────────────────────────
//
// DeepSeek 使用 React 渲染消息列表：流式期间与流结束后都可能重渲染子树，
// 直接 append 的 DOM 节点会被移除；工具调用也可能早于 assistant 消息挂载。
// 这里用「注册表 + 守护轮询」保证块最终一定可见：
//   1) 块被移除 → 按指纹/索引重挂到同一条 assistant 消息；
//   2) 找不到宿主 → 落到右下角可见兜底容器，宿主就绪后自动迁移；
//   3) 多次重挂仍被移除 → 降级到兜底容器，避免无限抖动。

const FALLBACK_HOST_ID = 'dpp-tool-fallback-host';
const FALLBACK_STYLE_ID = 'dpp-tool-fallback-css';
const RENDER_GUARD_INTERVAL_MS = 1000;
const RENDER_GUARD_MAX_REMOUNTS = 20;
const RENDER_GUARD_FALLBACK_AFTER = 3;

interface MountedBlockMeta {
  fingerprint: string;
  assistantIndex: number;
  sessionId: string | null;
  remounts: number;
  inFallback: boolean;
  /** 实时路径的调用键（轮次 + 原始调用），用于阻止同一调用被重复渲染。 */
  callKey?: string;
  /** 恢复路径的记录键，用于阻止持久化记录与实时块重复渲染。 */
  restoreKey?: string;
  /** 落兜底容器时的消息数量基线：只有新消息出现才迁移，避免挂到上一条回答。 */
  baselineMessageCount: number;
}

/** 轮次序号：TURN_START 递增，避免跨轮相同调用被误判为重复。 */
let turnSeq = 0;
/** 本轮工具块统一挂载的 assistant 消息（避免流式过程中挂到不同消息）。 */
let currentTurnHost: HTMLElement | null = null;

/** 一次工具调用的渲染键：同一轮内相同原始调用视为同一次渲染。 */
function callRenderKey(call: ToolCall): string {
  const base = (call.raw ?? '').trim() || `${call.name}:${JSON.stringify(call.payload ?? {})}`;
  return `t${turnSeq}#${base.slice(0, 240)}`;
}

function findLiveBlockByKey(key: string): HTMLElement | null {
  for (const block of mountedBlocks.keys()) {
    if (block.isConnected && block.dataset.callKey === key) return block;
  }
  return null;
}

function findLiveBlockByRestoreKey(key: string): HTMLElement | null {
  for (const block of mountedBlocks.keys()) {
    if (block.isConnected && block.dataset.restoreKey === key) return block;
  }
  for (const block of document.querySelectorAll<HTMLElement>(`.${BLOCK_CLASS}`)) {
    if (block.dataset.restoreKey === key) return block;
  }
  return null;
}

/** 本轮宿主：首次解析后缓存，保证同轮所有工具块挂到同一条回答。 */
function resolveTurnHost(): HTMLElement | null {
  if (currentTurnHost && document.contains(currentTurnHost)) return currentTurnHost;
  currentTurnHost = getLastAssistantMessage();
  return currentTurnHost;
}

const mountedBlocks = new Map<HTMLElement, MountedBlockMeta>();
let renderGuardTimer: number | null = null;
let guardTick = 0;

function assistantFingerprint(message: HTMLElement): string {
  return (message.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

function getFallbackHost(): HTMLElement {
  injectFallbackStyles();
  let host = document.getElementById(FALLBACK_HOST_ID) as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.id = FALLBACK_HOST_ID;
    host.className = 'dpp-tool-fallback';

    const label = document.createElement('div');
    label.className = 'dpp-tool-fallback-label';
    label.textContent = '工具执行结果（等待页面消息容器就绪）';
    host.appendChild(label);
    (document.body ?? document.documentElement)?.appendChild(host);
  }
  return host;
}

function releaseFallbackHostIfEmpty(): void {
  const host = document.getElementById(FALLBACK_HOST_ID);
  if (host && host.childElementCount <= 1) host.remove();
}

function injectFallbackStyles(): void {
  if (document.getElementById(FALLBACK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FALLBACK_STYLE_ID;
  style.textContent = `
.dpp-tool-fallback {
  position: fixed;
  right: 16px;
  bottom: 88px;
  z-index: 99990;
  width: min(380px, calc(100vw - 32px));
  max-height: 45vh;
  overflow-y: auto;
  padding: 8px;
  border-radius: 12px;
  border: 1px solid var(--ds-border, #E5E7EB);
  background: var(--ds-bg, #FFFFFF);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.12);
  overscroll-behavior: contain;
}
.dpp-tool-fallback-label {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 4px 6px;
  color: var(--ds-text-secondary, #6B7280);
}
`;
  (document.head ?? document.documentElement)?.appendChild(style);
}

/** 统一挂载入口：优先 assistant 宿主，找不到时落到可见兜底容器。 */
function mountToolBlock(
  block: HTMLElement,
  preferredMessage?: HTMLElement | null,
  options?: { callKey?: string; restoreKey?: string },
): void {
  const messages = findAssistantMessages();
  const target = preferredMessage ?? messages[messages.length - 1] ?? null;
  if (options?.callKey) block.dataset.callKey = options.callKey;
  if (options?.restoreKey) block.dataset.restoreKey = options.restoreKey;
  if (target) {
    getAssistantResponseHost(target).appendChild(block);
  } else {
    getFallbackHost().appendChild(block);
  }

  mountedBlocks.set(block, {
    fingerprint: target ? assistantFingerprint(target) : '',
    assistantIndex: target ? messages.indexOf(target) : -1,
    sessionId: getCurrentChatSessionId(),
    remounts: 0,
    inFallback: !target,
    callKey: options?.callKey,
    restoreKey: options?.restoreKey,
    baselineMessageCount: target ? -1 : messages.length,
  });
  startRenderGuard();
  reportRenderStatus();
}

/** 按指纹优先、索引兜底定位块所属的 assistant 消息。 */
function locateMessageForBlock(meta: MountedBlockMeta, messages: HTMLElement[]): HTMLElement | null {
  if (messages.length === 0) return null;

  if (meta.fingerprint) {
    const prefix = meta.fingerprint.slice(0, 16);
    const byIndex = meta.assistantIndex >= 0 ? messages[meta.assistantIndex] : null;
    if (byIndex && assistantFingerprint(byIndex).startsWith(prefix)) return byIndex;
    const byFingerprint = messages.find((message) => assistantFingerprint(message).startsWith(prefix));
    if (byFingerprint) return byFingerprint;
  }

  if (meta.assistantIndex >= 0 && messages[meta.assistantIndex]) return messages[meta.assistantIndex];

  // 无指纹（早期占位）：只有出现新的助手消息才迁移，避免把块挂到上一条回答上。
  if (meta.baselineMessageCount >= 0 && messages.length <= meta.baselineMessageCount) return null;
  return messages[messages.length - 1] ?? null;
}

function startRenderGuard(): void {
  if (renderGuardTimer !== null) return;
  renderGuardTimer = window.setInterval(guardMountedBlocks, RENDER_GUARD_INTERVAL_MS);
}

function stopRenderGuard(): void {
  if (renderGuardTimer === null) return;
  window.clearInterval(renderGuardTimer);
  renderGuardTimer = null;
}

function resetRenderGuard(): void {
  stopRenderGuard();
  mountedBlocks.clear();
  document.getElementById(FALLBACK_HOST_ID)?.remove();
}

/** 守护：块被 React 移除/移出宿主时自动重挂；多次失败降级到兜底容器。 */
function guardMountedBlocks(): void {
  if (mountedBlocks.size === 0) {
    stopRenderGuard();
    releaseFallbackHostIfEmpty();
    return;
  }
  if (document.hidden) return;

  // 性能：全部块健康时不必每轮扫描 DOM，仅在每 3 个 tick 做一次完整校验。
  guardTick += 1;
  const needsFullCheck = guardTick % 3 === 0;
  let allHealthy = true;
  for (const [block, meta] of mountedBlocks) {
    if (!block.isConnected || meta.inFallback) {
      allHealthy = false;
      break;
    }
  }
  if (allHealthy && !needsFullCheck) return;

  const sessionId = getCurrentChatSessionId();
  const messages = findAssistantMessages();

  for (const [block, meta] of mountedBlocks) {
    // 已切换到其他会话：旧会话的块交给持久化恢复路径处理。
    if (meta.sessionId && sessionId && meta.sessionId !== sessionId) continue;

    if (!block.isConnected) {
      if (meta.remounts >= RENDER_GUARD_MAX_REMOUNTS) {
        mountedBlocks.delete(block);
        continue;
      }
      if (meta.remounts >= RENDER_GUARD_FALLBACK_AFTER) {
        getFallbackHost().appendChild(block);
        meta.inFallback = true;
      } else {
        const target = locateMessageForBlock(meta, messages);
        if (target) {
          getAssistantResponseHost(target).appendChild(block);
          meta.inFallback = false;
          meta.fingerprint = assistantFingerprint(target);
          meta.assistantIndex = messages.indexOf(target);
        } else {
          getFallbackHost().appendChild(block);
          meta.inFallback = true;
        }
      }
      meta.remounts += 1;
      reportRenderStatus();
      continue;
    }

    const target = locateMessageForBlock(meta, messages);
    if (!target) continue;

    // 兜底容器中的块：消息容器就绪后迁回原位。
    if (meta.inFallback) {
      getAssistantResponseHost(target).appendChild(block);
      meta.inFallback = false;
      meta.fingerprint = assistantFingerprint(target);
      meta.assistantIndex = messages.indexOf(target);
      reportRenderStatus();
      continue;
    }

    // 仍 connected 但被移出了宿主（React 重建容器）：归位。
    if (!getAssistantResponseHost(target).contains(block)) {
      getAssistantResponseHost(target).appendChild(block);
      meta.remounts += 1;
      reportRenderStatus();
    }
  }

  releaseFallbackHostIfEmpty();
}

/** 向 MAIN world 上报渲染状态，供页面 console 的 __webtoolDeepseek.render 查看。 */
function reportRenderStatus(): void {
  try {
    const entries = [...mountedBlocks.values()];
    window.postMessage({
      source: 'WebTool-DeepSeek-content',
      type: 'RENDER_STATUS',
      data: {
        blocks: mountedBlocks.size,
        connected: [...mountedBlocks.keys()].filter((block) => block.isConnected).length,
        fallback: entries.filter((meta) => meta.inFallback).length,
        remounts: entries.reduce((sum, meta) => sum + meta.remounts, 0),
        updatedAt: Date.now(),
      },
    }, '*');
  } catch {
    // 上报失败不影响渲染
  }
}

async function handleToolCall(call: ToolCall, callId: number) {
  const renderKey = callRenderKey(call);

  // 同一轮内同一调用被重复通知（流式重解析 / 迟到的消息）：只补结果，绝不新建块。
  const duplicateBlock = findLiveBlockByKey(renderKey);
  if (duplicateBlock) {
    if (duplicateBlock.dataset.completed !== '1') {
      // 早期占位块没有经过上面两条路径登记 raw，这里必须先登记，
      // 否则随后到达的 EXECUTE_TOOL_CALL 会把同一调用再执行一次。
      resolvedCallRaws.add(call.raw);
      try {
        const result = await trackToolExecution(executeToolCall(call));
        updateToolBlockWithResult(duplicateBlock, call, result);
        duplicateBlock.dataset.completed = '1';
        collectTurnResult(call, result);
      } catch {
        // EXECUTE_TOOL_CALL 流程会处理
      }
    }
    return;
  }

  // Reuse existing tool block for this conversation turn
  if (currentToolBlock && document.contains(currentToolBlock)) {
    // 早期占位创建的块没有调用键：复用后补上，供收尾去重与后续精确匹配使用。
    if (!currentToolBlock.dataset.callKey) currentToolBlock.dataset.callKey = renderKey;
    const hasEarlyPlaceholder = consumeEarlyPlaceholder(call.name);
    if (!hasEarlyPlaceholder && !hasUnfinishedItemForName(currentToolBlock, call.name)) {
      addExecutingToolItem(currentToolBlock, call);
    }
    const entry = { call, block: currentToolBlock, callId, resolved: false };
    pendingCallMap.set(callId, entry);

    // Optimistic dedup: mark raw BEFORE async executeToolCall to prevent
    // EXECUTE_TOOL_CALL arriving during the round-trip from duplicating.
    resolvedCallRaws.add(call.raw);
    try {
      const result = await trackToolExecution(executeToolCall(call));
      if (!entry.resolved) {
        entry.resolved = true;
        updateToolBlockWithResult(entry.block, call, result);
        collectTurnResult(call, result);
      }
    } catch {
      // EXECUTE_TOOL_CALL flow will handle it
    }
    return;
  }

  // 本轮第一个工具块。注意：不要在这里清理 pendingCallMap / resolvedCallRaws，
  // 否则上一轮迟到的 EXECUTE_TOOL_CALL 会因缺失记录而被重新执行（表现为重复渲染）。
  // 清理统一放在 TURN_START 与 finalizeResponse。
  const host = resolveTurnHost();
  const block = createToolBlock(call);
  addExecutingToolItem(block, call);
  currentToolBlock = block;
  block.dataset.completed = '1';

  mountToolBlock(block, host, { callKey: renderKey });

  const entry = { call, block, callId, resolved: false };
  pendingCallMap.set(callId, entry);

  // Optimistic dedup: mark raw BEFORE async executeToolCall to prevent
  // EXECUTE_TOOL_CALL arriving during the round-trip from duplicating.
  resolvedCallRaws.add(call.raw);

  // Immediately start execution so the block shows the real result
  // instead of waiting for EXECUTE_TOOL_CALL after response complete
  try {
    const result = await trackToolExecution(executeToolCall(call));
    if (!entry.resolved) {
      entry.resolved = true;
      updateToolBlockWithResult(block, call, result);
      collectTurnResult(call, result);
    }
  } catch {
    // EXECUTE_TOOL_CALL flow will handle it
  }
}

async function executeToolCall(call: ToolCall): Promise<ToolCardResult> {
  try {
    const result = await safeRuntimeSendMessage<ToolCardResult>({ type: 'EXECUTE_TOOL_CALL', payload: call });
    const resolved = result ?? { ok: false, summary: '执行失败', detail: '后台未返回执行结果' };
    // memory_get 读到正文后通知 main-world：下一轮把正文补注入上下文，
    // 避免 agent 因为「只看到标题索引」而重复调用 memory_get。
    if (call.name === 'memory_get' && resolved.ok) {
      window.postMessage({
        source: 'WebTool-DeepSeek-content',
        type: 'MEMORY_CONTENT_READ',
        key: typeof call.payload?.key === 'string' ? call.payload.key : '',
      }, '*');
    }
    return resolved;
  } catch (err) {
    return { ok: false, summary: '执行失败', detail: err instanceof Error ? err.message : String(err) };
  }
}

function trackToolExecution<T>(promise: Promise<T>): Promise<T> {
  activeToolExecutions.add(promise);
  promise.finally(() => {
    activeToolExecutions.delete(promise);
  });
  return promise;
}

/** 收集本轮工具执行结果，供 finalizeResponse 续聊决策使用。 */
function collectTurnResult(call: ToolCall, result: ToolCardResult) {
  currentTurnToolNames.push(call.name);
  currentTurnResults.push({
    name: getToolDisplayName(call.name),
    ok: result.ok,
    summary: result.summary,
    detail: result.detail,
  });
}

/** 只读记忆查询工具：结果对用户可见，只查看时无需再触发一轮模型回答。 */
const MEMORY_READ_TOOL_NAMES = new Set([
  'memory_list',
  'memory_get',
  'memory_get_many',
  'memory_search',
  'memory_stats',
  'memory_handoff',
  'memory_connection_status',
  'memory_capabilities',
  'memory_data_inventory',
]);

function isMemoryReadToolName(name: string): boolean {
  return MEMORY_READ_TOOL_NAMES.has(name);
}

const MEMORY_VIEW_INTENT = /(查看|看看|显示|展示|列出|列一下|查一下|查询|读取|读一下|有哪些|是什么|记忆列表|列出来)/;
const TASK_INTENT = /(帮我|请|根据|按照|基于|使用|用|写|改|生成|实现|分析|总结|整理|翻译|继续|然后|接着|优化|修复|对比|评估|设计|执行|完成)/;

/**
 * 是否属于「只看记忆」：短句、含查看类词、不含任务类词。
 * 这类请求的工具结果已在工具卡片中展示，不必再自动续聊一轮。
 */
function isViewOnlyPrompt(prompt: string): boolean {
  const text = prompt.trim();
  if (!text || text.length > 60) return false;
  if (TASK_INTENT.test(text)) return false;
  return MEMORY_VIEW_INTENT.test(text);
}

/**
 * 被动记忆捕获：用本轮用户输入提炼候选记忆，送入待确认队列。
 * 只写候选，不写记忆库——是否记住由用户在侧边栏决定。
 */
function queueMemoryCandidates(userPrompt: unknown): void {
  if (typeof userPrompt !== 'string' || !userPrompt.trim()) return;
  const { candidates } = extractMemoryCandidates(userPrompt);
  if (candidates.length === 0) return;
  void safeRuntimeSendMessage({ type: 'ADD_MEMORY_CANDIDATES', payload: { candidates } });
}

async function finalizeResponse(meta?: { aborted?: boolean }) {
  // Auto-collapse all blocks, persist, and sync memory list
  const blocks = document.querySelectorAll<HTMLElement>(`.${BLOCK_CLASS}`);
  const hasBlocks = blocks.length > 0;
  const hadToolCallThisTurn = currentTurnResults.length > 0;

  currentToolBlock = null;

  if (hasBlocks) {
    if (activeToolExecutions.size > 0) {
      await Promise.allSettled([...activeToolExecutions]);
    }
    // 一轮结束：执行记录只服务于流式期去重，清空避免跨轮误判与内存增长。
    pendingCallMap.clear();
    resolvedCallRaws.clear();
    dedupeToolBlocks();
    persistToolExecutions();
    if (hadToolCallThisTurn) {
      // Refresh memory list in the side panel
      await refreshMemoryList();
    }
  }

  // 自动续聊：本轮有工具调用时，构造工具结果回传 prompt 并自动发送下一轮。
  // 例外：本轮只有只读记忆查询，且用户只是查看记忆 → 结果已在工具卡片展示，不再续聊。
  isAutoContinuing = false;
  const viewOnlyMemoryRead = hadToolCallThisTurn
    && currentTurnToolNames.length > 0
    && currentTurnToolNames.every(isMemoryReadToolName)
    && isViewOnlyPrompt(lastUserPrompt);
  if (viewOnlyMemoryRead) {
    continuationRound = 0;
    currentTurnResults.length = 0;
    scheduleBlockReinsert(hasBlocks);
  } else if (hadToolCallThisTurn) {
    // 用户中断 / 请求失败 / 未开启自动续聊：只保留工具结果，不替用户发消息。
    if (meta?.aborted === true || !autoContinueEnabled) {
      continuationRound = 0;
      currentTurnResults.length = 0;
      scheduleBlockReinsert(hasBlocks);
      return;
    }
    if (continuationRound >= MAX_CONTINUATION_ROUNDS) {
      continuationRound = 0;
      currentTurnResults.length = 0;
      return;
    }
    continuationRound += 1;
    const prompt = buildAutoContinuationPrompt(
      currentTurnResults,
      currentToolDescriptors.map((d) => d.invocationName),
    );
    currentTurnResults.length = 0;
    await triggerAutoContinue(prompt);
  } else {
    // 续聊响应中无工具调用 → 任务完成，重置计数。
    continuationRound = 0;
    scheduleBlockReinsert(hasBlocks);
  }
}

/** 延迟存活检查：React 可能在流完成后重渲染 message 子树移除外挂块，丢失则从持久化记录重挂。 */
function scheduleBlockReinsert(hasBlocks: boolean) {
  if (!hasBlocks) return;
  const sessionId = getCurrentChatSessionId();
  setTimeout(() => {
    if (getCurrentChatSessionId() !== sessionId) return;
    reinsertLostBlocks();
  }, 1500);
}

/** 延迟存活检查：若流完成后的 React 重渲染移除了工具块，从持久化记录重挂。 */
function reinsertLostBlocks() {
  if (document.querySelectorAll(`.${BLOCK_CLASS}`).length > 0) return;
  restorePersistedToolBlocks();
}

/**
 * 自动续聊：设置挂起的 continuation prompt，然后在 DeepSeek 输入框填入占位标记
 * 并触发发送。fetch-hook 拦截该请求时会用挂起的 prompt 替换占位标记，
 * 用户气泡仅显示标记文本，工具结果在注入层不显示。
 * 发送失败必须立即丢弃挂起的 prompt，否则后续用户消息会被自动内容顶替。
 */
async function triggerAutoContinue(prompt: string) {
  // 1. 标记续聊中（TURN_START 时不重置续聊计数）。
  isAutoContinuing = true;

  // 2. 人类级延迟（2–5s 随机）：流一结束就 250ms 内发下一条是典型的机器人时序。
  //    严格等间隔同样是机器特征，所以用随机区间。
  const sessionIdBeforeWait = getCurrentChatSessionId();
  const turnSeqBeforeWait = turnSeq;
  await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 3000));

  // 3. 等待期间用户可能切了对话、自己发了消息或关掉了开关：此时放弃，不发任何请求。
  if (
    !autoContinueEnabled
    || getCurrentChatSessionId() !== sessionIdBeforeWait
    || turnSeq !== turnSeqBeforeWait
  ) {
    isAutoContinuing = false;
    return;
  }

  // 4. 通知 main-world 设置挂起的 continuation prompt（尽量贴近发送，缩短残留窗口）。
  window.postMessage({
    source: 'WebTool-DeepSeek-content',
    type: 'SET_CONTINUATION_PROMPT',
    prompt,
  }, '*');

  // 5. 在输入框填入占位标记并发送。
  const sent = await fillAndSendPrompt(CONTINUATION_MARKER);
  if (sent) return;

  // 6. 发送未被确认：只丢弃挂起 prompt 与状态标记，**不清空轮次计数**。
  // 若实际已发出（校验误判），清零会让上限 2 轮被无限续命——这正是要抑制的行为；
  // 若确实没发出，用户下一条手动消息会在 TURN_START 自然重置计数。
  clearPendingContinuation();
  isAutoContinuing = false;
}

/** 丢弃挂起的续聊 prompt（发送失败/放弃续聊时调用）。 */
function clearPendingContinuation() {
  window.postMessage({
    source: 'WebTool-DeepSeek-content',
    type: 'SET_CONTINUATION_PROMPT',
    prompt: null,
  }, '*');
}

/**
 * 填入 DeepSeek 输入框并触发发送，返回是否确认已发出。
 * 优先用 native setter 设值并派发 input 事件触发 React 状态更新；
 * 发送优先点击输入区内的发送按钮，找不到就回退 Enter 键。
 * 发送成功的判据：输入框被清空（DeepSeek 提交后会清空输入）。
 */
async function fillAndSendPrompt(text: string): Promise<boolean> {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea#chat-input')
    ?? document.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) return false;

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(textarea, text);
  } else {
    textarea.value = text;
  }
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.focus();

  // 等待 React 状态更新使发送按钮可用。
  await new Promise((resolve) => setTimeout(resolve, 250));

  const sendBtn = findSendButton(textarea);
  if (sendBtn) {
    sendBtn.click();
  } else {
    // 回退：模拟 Enter 键提交。
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }

  // 校验确实发出（最多等 1.2s）。未清空 = 没发出去，交给调用方丢弃挂起 prompt。
  for (let i = 0; i < 24; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (textarea.value.trim() === '') return true;
  }

  // 未被确认发出：若输入框还停留在我们写入的文本（含 Enter 被当成换行的情况），
  // 必须清掉，否则残留的「继续」会被用户下一次发送带出去，成一条真实空消息。
  if (textarea.value.trim() === text.trim()) {
    if (setter) setter.call(textarea, '');
    else textarea.value = '';
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: '' }));
  }
  return false;
}

/**
 * 查找 DeepSeek 发送按钮。
 * 只在输入框所在容器内查找带「发送/Send」语义的按钮，
 * 绝不在全局按通用结构猜按钮——那会点到侧边栏、模型切换等无关控件。
 * 找不到时返回 null，由调用方回退到 Enter 键。
 */
function findSendButton(textarea: HTMLTextAreaElement): HTMLElement | null {
  const containers: Element[] = [];
  let node: Element | null = textarea.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    containers.push(node);
  }

  const selectors = [
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    '[role="button"][aria-label*="发送"]',
    '[role="button"][aria-label*="Send"]',
  ];

  for (const container of containers) {
    for (const selector of selectors) {
      const el = container.querySelector<HTMLElement>(selector);
      if (!el) continue;
      // SVG 命中时向上解析真实可点击元素，避免对 SVGElement 调用不存在的 click()。
      const clickTarget = el.closest<HTMLElement>('button, [role="button"]') ?? el;
      if (!(clickTarget instanceof HTMLElement)) continue;
      if (clickTarget.getAttribute('aria-disabled') === 'true' || (clickTarget as HTMLButtonElement).disabled) continue;
      return clickTarget;
    }
  }
  return null;
}

// ─── Tool Block Persistence ───────────────────────────────────────

function getCurrentChatSessionId(): string | null {
  const match = window.location.pathname.match(/\/chat\/s\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function getRecordChatSessionId(record: ToolCallRestoreRecord): string | null {
  const value = record.metadata?.chatSessionId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isCurrentChatSessionRecord(record: ToolCallRestoreRecord): boolean {
  const recordSessionId = getRecordChatSessionId(record);
  const currentSessionId = getCurrentChatSessionId();
  if (recordSessionId || currentSessionId) return recordSessionId === currentSessionId;
  return true;
}

function getToolRestoreStorageKey(sessionId = getCurrentChatSessionId()): string {
  return STORAGE_PREFIX + (sessionId ?? window.location.pathname);
}

async function persistToolRestoreRecords(records: ToolCallRestoreRecord[]) {
  if (records.length === 0) return;

  const byKey = new Map<string, ToolCallRestoreRecord[]>();
  records.forEach((record) => {
    const key = getToolRestoreStorageKey(getRecordChatSessionId(record));
    const group = byKey.get(key) ?? [];
    group.push(record);
    byKey.set(key, group);
  });

  const updates: Record<string, unknown> = {};
  for (const [key, group] of byKey) {
    const data = await safeStorageLocalGet(key);
    const stored = data?.[key];
    const existing = Array.isArray(stored) ? stored as ToolCallRestoreRecord[] : [];
    const merged = new Map(existing.map((record) => [getToolRestoreRecordKey(record), record]));

    group.forEach((record) => {
      merged.set(getToolRestoreRecordKey(record), record);
    });

    updates[key] = [...merged.values()];
  }

  await safeStorageLocalSet(updates);
}

function getToolRestoreRecordKey(record: ToolCallRestoreRecord): string {
  return record.id || `${record.source}:${record.timestamp}:${record.content}`;
}

function persistToolExecutions() {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(`.${BLOCK_CLASS}`))
    .filter((block) => isElementVisible(block));
  const records: ToolCallRestoreRecord[] = [];
  const assistantMessages = findAssistantMessages();

  blocks.forEach((block) => {
    const items = block.querySelectorAll('.dpp-tb-item');
    const executions: ToolExecutionRecord[] = [];

    items.forEach((item) => {
      const nameEl = item.querySelector('.dpp-tb-item-name');
      const statusEl = item.querySelector('.dpp-tb-item-status');
      const detailEl = item.querySelector('.dpp-tb-item-detail');
      const dot = item.querySelector('.dpp-tb-dot');
      const isDone = dot?.classList.contains('is-done') ?? false;
      const isError = dot?.classList.contains('is-error') ?? false;
      const summary = statusEl?.textContent || '';
      if ((!isDone && !isError) || isPendingToolSummary(summary)) return;

      const detail = detailEl?.textContent || '';
      executions.push({
        name: nameEl?.textContent || '',
        result: { ok: isDone, summary, detail },
      });
    });

    if (executions.length > 0) {
      const assistantMessage = getAssistantMessageRoot(block) as HTMLElement | null;
      const assistantIndex = assistantMessage ? assistantMessages.indexOf(assistantMessage) : -1;
      const cleanContent = assistantMessage ? getAssistantMessageVisibleText(assistantMessage) : '';
      records.push({
        id: crypto.randomUUID(),
        calls: [],
        executions,
        content: cleanContent,
        source: 'persisted',
        url: window.location.href,
        timestamp: Date.now(),
        metadata: {
          cleanContent,
          ...(assistantIndex >= 0 ? { assistantIndex } : {}),
          ...(getCurrentChatSessionId() ? { chatSessionId: getCurrentChatSessionId() } : {}),
        },
      });
    }
  });

  if (records.length > 0) {
    safeStorageLocalSet({ [getToolRestoreStorageKey()]: records });
  }
}

function isPendingToolSummary(value: string): boolean {
  return value.trim() === '执行中...';
}

function getAssistantMessageVisibleText(message: HTMLElement): string {
  const clone = message.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`.${BLOCK_CLASS}`).forEach((el) => {
    el.remove();
  });
  return (clone.textContent || '').trim();
}

function clearRenderedToolBlocks() {
  document.querySelectorAll(`.${BLOCK_CLASS}`).forEach((block) => {
    block.remove();
  });
  mountedBlocks.clear();
}

/**
 * 收尾去重：同一调用键 / 恢复键只保留一个块（保留条目更多的那个），
 * 兜住任何漏网的重复渲染路径。
 */
function dedupeToolBlocks(): void {
  const kept = new Map<string, HTMLElement>();
  for (const block of document.querySelectorAll<HTMLElement>(`.${BLOCK_CLASS}`)) {
    const key = block.dataset.callKey || block.dataset.restoreKey;
    if (!key) continue;
    const previous = kept.get(key);
    if (!previous) {
      kept.set(key, block);
      continue;
    }
    const previousItems = previous.querySelectorAll('.dpp-tb-item').length;
    const currentItems = block.querySelectorAll('.dpp-tb-item').length;
    if (currentItems > previousItems) {
      previous.remove();
      mountedBlocks.delete(previous);
      kept.set(key, block);
    } else {
      block.remove();
      mountedBlocks.delete(block);
    }
  }
}

function markRouteRestoreWindow() {
  // DeepSeek 切换对话时可能先更新 URL、后异步渲染缓存 DOM；窗口期内才允许缓存恢复补卡。
  const until = Date.now() + ROUTE_RESTORE_WINDOW_MS;
  routeRestoreUntil = until;
  suppressToolPlaceholderUntil = until;
}

function isRouteRestoreWindowActive(): boolean {
  return Date.now() < routeRestoreUntil;
}

async function restorePersistedToolBlocks() {
  if (isRestoring) {
    // 已有恢复 retry 循环在进行（如 900ms 恢复未完），标记待重试后返回，
    // 避免并发 retry 循环产生竞争。
    pendingRestoreRetry = true;
    return;
  }
  isRestoring = true;
  try {
    const key = getToolRestoreStorageKey();
    const data = await safeStorageLocalGet(key);
    if (!data) { finishRestore(); return; }
    const stored = data[key];
    if (!Array.isArray(stored)) { finishRestore(); return; }

    const records = (stored as ToolCallRestoreRecord[]).filter(isCurrentChatSessionRecord);
    const hydratedRecords = await hydrateToolCallRestoreRecords(records);
    // 本地持久化恢复通常发生在路由切换后，DOM 可能还没稳定；先内容匹配，延迟几轮后才允许索引兜底。
    // renderRestoredToolBlocks 在不再 retry 的退出点调 finishRestore 清除 isRestoring。
    renderRestoredToolBlocks(hydratedRecords, key, 0, {
      allowAssistantIndexFallback: true,
      assistantIndexFallbackMinAttempt: 3,
    });
  } catch {
    finishRestore();
  }
}

/** 恢复结束：清除进行中标志，并处理待重试的恢复请求。 */
function finishRestore() {
  isRestoring = false;
  if (pendingRestoreRetry) {
    pendingRestoreRetry = false;
    void restorePersistedToolBlocks();
  }
}

async function hydrateToolCallRestoreRecords(records: ToolCallRestoreRecord[]): Promise<ToolCallRestoreRecord[]> {
  if (records.every((record) => record.executions.length > 0 || record.calls.length === 0)) return records;

  const history = await safeRuntimeSendMessage<ToolCallHistoryRecord[]>({ type: 'GET_TOOL_CALL_HISTORY', payload: { limit: 200 } }) ?? [];
  return records.map((record) => {
    if (record.executions.length > 0 || record.calls.length === 0) return record;
    const executions = record.calls.map((call) => createExecutionRecordFromHistory(call, history));
    return { ...record, executions };
  });
}

function createExecutionRecordFromHistory(call: ToolCall, history: ToolCallHistoryRecord[]): ToolExecutionRecord {
  const matched = history.find((record) => isSameToolCall(record.call, call));
  return {
    // 统一使用工具中文标题（与实时渲染一致），原始调用名仅作 fallback。
    name: getToolDisplayName(call.name),
    provider: call.provider,
    descriptorId: call.descriptorId,
    result: matched?.result
      ? {
          ok: matched.result.ok,
          summary: matched.result.summary,
          detail: matched.result.detail,
          output: matched.result.output,
          truncated: matched.result.truncated,
          error: matched.result.error,
        }
      : { ok: false, summary: '历史结果未找到', detail: '该工具调用结果未在本地历史中找到' },
  };
}

function isSameToolCall(a: ToolCall, b: ToolCall): boolean {
  if (a.raw && b.raw && a.raw === b.raw) return true;
  if (a.descriptorId && b.descriptorId && a.descriptorId !== b.descriptorId) return false;
  if (a.name !== b.name) return false;
  return stableStringify(a.payload) === stableStringify(b.payload);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

interface RestoreRenderOptions {
  allowAssistantIndexFallback?: boolean;
  assistantIndexFallbackMinAttempt?: number;
}

function renderRestoredToolBlocks(
  records: ToolCallRestoreRecord[],
  storageKey = getToolRestoreStorageKey(),
  attempt = 0,
  options: RestoreRenderOptions = {},
) {
  // 恢复过程可能跨路由重试；storage key 变化说明用户已离开当前对话，旧重试必须停止。
  if (storageKey !== getToolRestoreStorageKey()) { finishRestore(); return; }
  const pendingRecords: ToolCallRestoreRecord[] = [];
  const assistantMessages = findAssistantMessages();
  const usedMessages = new Set<HTMLElement>();
  const restorableRecords = records
    .map((record) => ({
      ...record,
      executions: record.executions.filter((exec) => !isPendingToolSummary(exec.result.summary) && !isPendingToolSummary(exec.result.detail || '')),
    }))
    .filter((record) => record.executions.length > 0);

  if (assistantMessages.length < restorableRecords.length && attempt < 60) {
    setTimeout(() => renderRestoredToolBlocks(records, storageKey, attempt + 1, options), 300);
    return;
  }

  restorableRecords.forEach((record) => {
    const targetMessage = findAssistantMessageForToolRecord(record, assistantMessages, usedMessages, options, attempt);
    if (!targetMessage) {
      pendingRecords.push(record);
      return;
    }

    appendRestoredToolBlock(targetMessage, record);
    usedMessages.add(targetMessage);
  });

  if (pendingRecords.length > 0 && attempt < 60) {
    setTimeout(() => renderRestoredToolBlocks(pendingRecords, storageKey, attempt + 1, options), 300);
    return;
  }
  // 不再 retry：恢复结束，清除进行中标志并处理待重试请求。
  finishRestore();
}

function findAssistantMessageForToolRecord(
  record: ToolCallRestoreRecord,
  assistantMessages: HTMLElement[],
  usedMessages: Set<HTMLElement>,
  options: RestoreRenderOptions,
  attempt: number,
): HTMLElement | null {
  const cleanContent = typeof record.metadata?.cleanContent === 'string' ? record.metadata.cleanContent : '';
  const normalizedRecordContent = normalizeToolRecordText(cleanContent || record.content);

  // 内容匹配优先于 assistantIndex，避免对话切换或缓存渲染时把旧卡片挂到同序号的新消息。
  if (normalizedRecordContent) {
    const contentMatch = assistantMessages.find((message) => {
      if (usedMessages.has(message) || hasExistingToolBlock(message)) return false;
      const normalizedMessageText = normalizeToolRecordText(message.textContent || '');
      if (!normalizedMessageText) return false;
      return normalizedMessageText.includes(normalizedRecordContent) || normalizedRecordContent.includes(normalizedMessageText);
    });
    if (contentMatch) return contentMatch;
  }

  if (options.allowAssistantIndexFallback === true) {
    const minAttempt = options.assistantIndexFallbackMinAttempt ?? 0;
    // 只有在内容匹配多次失败后才使用历史索引兜底，降低缓存 DOM 未稳定时的误挂载概率。
    if (attempt < minAttempt) return null;

    const assistantIndex = typeof record.metadata?.assistantIndex === 'number' ? record.metadata.assistantIndex : null;
    const indexedMessage = assistantIndex !== null ? assistantMessages[assistantIndex] : null;
    if (indexedMessage && !usedMessages.has(indexedMessage) && !hasExistingToolBlock(indexedMessage)) {
      return indexedMessage;
    }
  }

  return null;
}

function normalizeToolRecordText(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/工具调用\d*/g, '')
    .trim();
}

/**
 * 恢复渲染的状态文本：只显示标题/短摘要，绝不重复 detail 全文。
 *
 * 兼容旧版本持久化记录——它们把 detail 一并写进了 summary。
 */
function resolveRestoredStatus(exec: ToolExecutionRecord): string {
  const summary = (exec.result.summary ?? '').trim();
  const detailText = (exec.result.detail ?? '').trim();
  if (!summary || summary === exec.name || summary === '已执行' || summary === '执行中...') return '';
  if (detailText && summary === detailText) {
    // 旧记录：从 detail 首行（`#89 [topic] 标题`）提取标题。
    const firstLine = detailText.split('\n')[0]?.trim() ?? '';
    const match = firstLine.match(/^#\d+ \[[^\]]+\]\s*(.+)$/);
    return match?.[1]?.trim() ?? '';
  }
  // 长摘要（旧格式或非记忆工具的大段内容）截断，避免挤占状态行。
  if (summary.length > 120) return `${summary.slice(0, 120)}…`;
  return summary;
}

function appendRestoredToolBlock(targetMessage: HTMLElement, record: ToolCallRestoreRecord) {
  const restoreKey = getToolRestoreRecordKey(record);
  // 同一记录已在页面上渲染过（实时块或上一次恢复）→ 不再重复挂载。
  if (findLiveBlockByRestoreKey(restoreKey)) return;
  if (hasExistingToolBlock(targetMessage)) return;

  const block = document.createElement('div');
  block.className = BLOCK_CLASS;
  block.setAttribute('data-collapsed', 'false');

  block.innerHTML = `
      <div class="dpp-tb-header" role="button" tabindex="0" aria-expanded="true">
        <div class="dpp-tb-header-ripple"></div>
        <span class="dpp-tb-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        </span>
        <span class="dpp-tb-title">工具调用</span>
        <span class="dpp-tb-chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </div>
      <div class="dpp-tb-body"></div>
    `;

  setToolBlockTitle(block, record.executions.length);

  const body = block.querySelector('.dpp-tb-body');
  for (const exec of record.executions) {
    const detail = formatToolResultDetail(exec.result);
    body?.appendChild(createToolBlockItem(exec.name, resolveRestoredStatus(exec), exec.result.ok ? 'done' : 'error', detail));
  }

  const header = block.querySelector('.dpp-tb-header') as HTMLElement;
  header.addEventListener('click', () => toggleBlockCollapse(block));
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleBlockCollapse(block);
    }
  });

  mountToolBlock(block, targetMessage, { restoreKey });
  injectBlockStyles();
}

// ─── DOM Tool Tag Cleanup ─────────────────────────────────────────

function scheduleToolCleanupForMessage(assistantMessage: Element) {
  // DeepSeek 流式渲染会产生大量 DOM mutation；按消息去重到下一帧处理，避免整页反复扫描。
  pendingToolCleanupMessages.add(assistantMessage);
  if (toolCleanupFrame !== null) return;

  toolCleanupFrame = requestAnimationFrame(() => {
    toolCleanupFrame = null;
    const messages = [...pendingToolCleanupMessages];
    pendingToolCleanupMessages.clear();

    for (const message of messages) {
      if (message.isConnected) {
        cleanRenderedToolCallsInMessage(message);
      }
    }
  });
}

function shouldScheduleToolCleanup(assistantMessage: Element, text: string): boolean {
  return hasPotentialToolMarkup(text);
}

function getFirstAssistantMessageDescendant(element: Element): Element | null {
  return element.querySelector(ASSISTANT_MESSAGE_SELECTOR);
}

function cleanRenderedToolCalls() {
  for (const assistantMessage of findAssistantMessages()) {
    cleanRenderedToolCallsInMessage(assistantMessage);
  }
}

function cleanRenderedToolCallsInMessage(assistantMessage: Element) {
  cleanRenderedToolCallElements(assistantMessage);

  const walker = document.createTreeWalker(assistantMessage, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (isInsideToolBlock(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  let n: Node | null;
  while (true) {
    n = walker.nextNode();
    if (!n) break;
    targets.push(n as Text);
  }

  const foundTags = cleanCompleteToolCallsAcrossTextNodes(targets);
  if (foundTags && Date.now() >= suppressToolPlaceholderUntil) {
    for (const tag of foundTags) renderEarlyToolPlaceholder(tag, assistantMessage);
  }

  cleanupEmptyMarkdownParagraphs(assistantMessage);
}

function cleanRenderedToolCallElements(assistantMessage: Element): Set<string> | null {
  const names = getRecognizedToolTagNames();
  if (names.length === 0) return null;
  const tagNames = new Map(names.map((name) => [name.toLowerCase(), name]));
  // 只查询已知工具标签，避免对整条消息做全量 * 遍历。
  const selector = names.map((name) => CSS.escape(name)).join(',');

  const foundTags = new Set<string>();
  assistantMessage.querySelectorAll(selector).forEach((element) => {
    if (isInsideToolBlock(element)) return;
    const tagName = tagNames.get(element.localName.toLowerCase());
    if (!tagName) return;
    foundTags.add(tagName);
    element.remove();
  });

  return foundTags.size > 0 ? foundTags : null;
}

function cleanupEmptyMarkdownParagraphs(assistantMessage: Element) {
  assistantMessage.querySelectorAll('p.ds-markdown-paragraph').forEach((paragraph) => {
    if ((paragraph.textContent || '').trim()) return;
    paragraph.remove();
  });
}

function cleanCompleteToolCallsAcrossTextNodes(nodes: Text[]): Set<string> | null {
  if (nodes.length === 0) return null;

  const segments = nodes.map((node) => node.textContent || '');
  const combined = segments.join('');
  if (!hasPotentialToolMarkup(combined)) return null;

  const ranges = findCompleteToolRemovalRanges(combined);
  if (ranges.length === 0) return null;

  const nodeStarts: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    nodeStarts.push(offset);
    offset += segment.length;
  }

  let changed = false;
  const foundTags = new Set<string>();
  nodes.forEach((node, index) => {
    const segment = segments[index];
    const nodeStart = nodeStarts[index];
    const nodeEnd = nodeStart + segment.length;

    let next = '';
    let cursor = 0;

    for (const range of ranges) {
      if (range.end <= nodeStart || range.start >= nodeEnd) continue;
      if (range.tagName) foundTags.add(range.tagName);
      const localStart = Math.max(0, range.start - nodeStart);
      const localEnd = Math.min(segment.length, range.end - nodeStart);
      next += segment.slice(cursor, localStart);
      cursor = Math.max(cursor, localEnd);
    }

    next += segment.slice(cursor);
    if (next !== segment) {
      node.textContent = next;
      changed = true;
    }
  });

  return changed ? foundTags : null;
}

function findCompleteToolRemovalRanges(text: string): TextRemovalRange[] {
  const ranges: TextRemovalRange[] = [];
  const catalog = createToolInvocationCatalog(currentToolDescriptors, RECOGNIZED_TOOL_TAGS);
  const regex = createXmlToolCallRegex(catalog);
  let match: RegExpExecArray | null = regex.exec(text);

  while (match) {
    ranges.push({ start: match.index, end: match.index + match[0].length, tagName: match[1] ?? null });
    match = regex.exec(text);
  }

  const legacyRegex = /<｜DSML｜tool_calls>[\s\S]*?<\/｜DSML｜tool_calls>/g;
  match = legacyRegex.exec(text);
  while (match) {
    ranges.push({ start: match.index, end: match.index + match[0].length, tagName: null });
    match = legacyRegex.exec(text);
  }

  return mergeTextRemovalRanges(ranges.toSorted((a, b) => a.start - b.start || b.end - a.end));
}

function mergeTextRemovalRanges(ranges: TextRemovalRange[]): TextRemovalRange[] {
  const merged: TextRemovalRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
    previous.tagName ??= range.tagName;
  }
  return merged;
}

// ─── DOM Observer (background image patching + tool block + tool cleanup) ──

let toolRestoreTimer: ReturnType<typeof setTimeout> | null = null;
/** 恢复进行中标志，防止并发 retry 循环（ROUTE_CHANGED 的两次恢复触发）。 */
let isRestoring = false;
/** 恢复期间有新的恢复请求到达时标记，待当前恢复结束后重试。 */
let pendingRestoreRetry = false;

function scheduleRestore() {
  if (toolRestoreTimer) clearTimeout(toolRestoreTimer);
  toolRestoreTimer = setTimeout(() => {
    toolRestoreTimer = null;
    restorePersistedToolBlocks();
  }, 200);
}

function setupDOMObserver() {
  let patchTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPathname = window.location.pathname;

  const checkRouteChange = () => {
    if (lastPathname === window.location.pathname) return;
    lastPathname = window.location.pathname;
    markRouteRestoreWindow();
    scheduleRestore();
  };

  const observer = new MutationObserver((mutations) => {
    checkRouteChange();
    let needsPatch = false;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        handleTextMutation(mutation);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          handleTextNodeAdded(node);
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as HTMLElement;
        needsPatch = true;
        handleElementAdded(el);
      }
    }

    if (needsPatch && document.body.classList.contains('dpp-bg-active')) {
      if (patchTimer) clearTimeout(patchTimer);
      patchTimer = setTimeout(() => {
        patchTimer = null;
        patchContainerBackgrounds();
      }, 200);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

/** 文本节点内容变化（流式输出）时调度工具标记清理。 */
function handleTextMutation(mutation: MutationRecord) {
  const parent = mutation.target.parentElement;
  const assistantMessage = parent ? getAssistantMessageRoot(parent) : null;
  if (!assistantMessage) return;
  const text = mutation.target.textContent || '';
  if (shouldScheduleToolCleanup(assistantMessage, text)) {
    scheduleToolCleanupForMessage(assistantMessage);
  }
}

/** 新增文本节点（流式输出追加）时调度工具标记清理。 */
function handleTextNodeAdded(node: Node) {
  const parent = node.parentElement;
  const assistantMessage = parent ? getAssistantMessageRoot(parent) : null;
  if (!assistantMessage) return;
  const text = node.textContent || '';
  if (shouldScheduleToolCleanup(assistantMessage, text)) {
    scheduleToolCleanupForMessage(assistantMessage);
  }
}

/** 新增元素节点：路由恢复窗口内尝试恢复工具卡片；同时调度工具标记清理。 */
function handleElementAdded(el: HTMLElement) {
  if (getAssistantMessageRoot(el) || getFirstAssistantMessageDescendant(el)) {
    scheduleRestore();
  }
  if (isInsideToolBlock(el)) return;
  const assistantMessage = getAssistantMessageRoot(el) ?? getFirstAssistantMessageDescendant(el);
  if (!assistantMessage) return;
  if (shouldScheduleToolCleanup(assistantMessage, el.textContent || '')) {
    scheduleToolCleanupForMessage(assistantMessage);
  }
}

function hasPotentialToolMarkup(text: string): boolean {
  return getRecognizedToolTagNames().some((tag) => text.includes(`<${tag}>`) || text.includes(`</${tag}>`)) || /<｜DSML｜tool_calls>/.test(text);
}

function getRecognizedToolTagNames(): string[] {
  const names = new Set(RECOGNIZED_TOOL_TAGS);
  for (const descriptor of currentToolDescriptors) {
    const invocationName = descriptor.invocationName.trim();
    if (invocationName) names.add(invocationName);
  }
  return [...names];
}

// ─── Background Image (unchanged from original) ───────────────────

function hasVisibleBackground(style: CSSStyleDeclaration): boolean {
  const bg = style.backgroundColor;
  const bgImg = style.backgroundImage;
  return (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') ||
         (bgImg !== 'none' && bgImg !== '');
}

function patchContainerBackgrounds() {
  if (!document.body.classList.contains('dpp-bg-active')) return;
  const root = document.getElementById('root');
  if (!root) return;

  const textarea = document.querySelector('textarea');
  if (!textarea) return;

  let inputBox: Element | null = null;
  let el: Element | null = textarea.parentElement;
  while (el && el !== root) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg === 'rgb(255, 255, 255)' || bg === 'rgb(249, 250, 251)') {
      inputBox = el;
      break;
    }
    el = el.parentElement;
  }

  if (!inputBox) return;

  el = inputBox.parentElement;
  while (el && el !== root && el !== document.body) {
    const style = getComputedStyle(el);
    if (hasVisibleBackground(style)) {
      (el as HTMLElement).setAttribute('data-dpp-transparent', '');
    }

    if (style.position === 'sticky') {
      for (const child of el.children) {
        if (child.contains(textarea)) continue;
        if (hasVisibleBackground(getComputedStyle(child))) {
          (child as HTMLElement).setAttribute('data-dpp-transparent', '');
        }
      }
    }

    el = el.parentElement;
  }
}

function getToolbarBottom(): number {
  const root = document.getElementById('root');
  if (!root) return 0;

  function walk(el: Element): number {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (
      rect.top >= -2 && rect.top <= 5 &&
      rect.height > 30 && rect.height <= 80 &&
      rect.width > 300 &&
      (style.position === 'absolute' || style.position === 'sticky' || style.position === 'fixed')
    ) {
      return rect.bottom;
    }
    for (const child of el.children) {
      const result = walk(child);
      if (result > 0) return result;
    }
    return 0;
  }

  return walk(root);
}

function getPromptUiSystemTheme(): ResolvedTheme {
  return window.matchMedia(THEME_QUERY).matches ? 'dark' : 'light';
}

function applyPromptUiTheme(preference: ThemePreference) {
  currentPromptThemePreference = preference;
  const resolvedTheme = resolveTheme(preference, getPromptUiSystemTheme());
  const root = document.documentElement;
  root.dataset.dppTheme = resolvedTheme;
  root.style.setProperty('--dpp-prompt-bg', resolvedTheme === 'dark' ? '#121A2B' : '#FFFFFF');
  root.style.setProperty('--dpp-prompt-text', resolvedTheme === 'dark' ? '#E5E5E5' : '#1D1D1F');
  root.style.setProperty('--dpp-prompt-border', resolvedTheme === 'dark' ? '#334155' : '#E5E7EB');
  root.style.setProperty('--dpp-prompt-active-bg', resolvedTheme === 'dark' ? '#172033' : '#F7F8FA');
  root.style.setProperty('--dpp-prompt-text-muted', resolvedTheme === 'dark' ? '#94A3B8' : '#9CA3AF');
  root.style.setProperty('--dpp-prompt-text-faint', resolvedTheme === 'dark' ? '#64748B' : '#D1D5DB');
  root.style.setProperty('--dpp-prompt-hint-border', resolvedTheme === 'dark' ? '#1E293B' : '#F3F4F6');
  root.style.setProperty('--dpp-prompt-shadow', resolvedTheme === 'dark' ? '0 8px 28px rgba(0,0,0,0.42), 0 1px 4px rgba(0,0,0,0.32)' : '0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)');
  root.style.setProperty('--dpp-skill-color', resolvedTheme === 'dark' ? '#8EA2FF' : '#4D6BFE');
  root.style.setProperty('--dpp-skill-bg', resolvedTheme === 'dark' ? '#1E2B52' : '#EEF1FF');
  root.style.setProperty('--dpp-memory-color', resolvedTheme === 'dark' ? '#A78BFA' : '#8B5CF6');
  root.style.setProperty('--dpp-memory-bg', resolvedTheme === 'dark' ? '#2E1065' : '#F5F3FF');
  root.style.setProperty('--dpp-preset-color', resolvedTheme === 'dark' ? '#FBBF24' : '#D97706');
  root.style.setProperty('--dpp-preset-bg', resolvedTheme === 'dark' ? '#3A2604' : '#FFFBEB');
  root.style.setProperty('--dpp-preset-border', resolvedTheme === 'dark' ? '#854D0E' : '#FDE68A');
  root.style.setProperty('--dpp-danger-color', resolvedTheme === 'dark' ? '#F87171' : '#EF4444');
  root.style.setProperty('--dpp-danger-bg', resolvedTheme === 'dark' ? '#3B0A0A' : '#FEF2F2');
  root.style.setProperty('--dpp-success-color', resolvedTheme === 'dark' ? '#34D399' : '#10B981');
  root.style.setProperty('--dpp-success-bg', resolvedTheme === 'dark' ? '#052E24' : '#ECFDF5');
  root.style.setProperty('--dpp-info-color', resolvedTheme === 'dark' ? '#60A5FA' : '#3B82F6');
  root.style.setProperty('--dpp-info-bg', resolvedTheme === 'dark' ? '#0B214A' : '#EFF6FF');
  root.style.setProperty('--dpp-reference-color', resolvedTheme === 'dark' ? '#FBBF24' : '#F59E0B');
  root.style.setProperty('--dpp-reference-bg', resolvedTheme === 'dark' ? '#3A2604' : '#FFFBEB');
}

function removeBackground() {
  document.getElementById('dpp-bg')?.remove();
  document.getElementById('dpp-bg-style')?.remove();
  document.body.classList.remove('dpp-bg-active');
  document.body.style.removeProperty('--dpp-overlay-light');
  document.body.style.removeProperty('--dpp-overlay-dark');
  document.body.style.removeProperty('--dpp-blur');
}

function applyBackground(config: BackgroundConfig | null) {
  const imageUrl = config?.enabled
    ? (config.type === 'url' ? config.url : config.imageData) || null
    : null;

  if (!imageUrl) {
    removeBackground();
    return;
  }

  const existingBg = document.getElementById('dpp-bg');
  const existingStyle = document.getElementById('dpp-bg-style');
  const cfg = config!;

  document.body.classList.add('dpp-bg-active');

  const overlayAlpha = (1 - cfg.opacity).toFixed(3);
  const blurPx = ((1 - cfg.opacity) * 8).toFixed(1);
  document.body.style.setProperty('--dpp-overlay-light', `rgba(255, 255, 255, ${overlayAlpha})`);
  document.body.style.setProperty('--dpp-overlay-dark', `rgba(30, 30, 30, ${overlayAlpha})`);
  document.body.style.setProperty('--dpp-blur', `blur(${blurPx}px)`);

  const topOffset = getToolbarBottom();

  const bgDiv = existingBg || document.createElement('div');
  bgDiv.id = 'dpp-bg';
  Object.assign(bgDiv.style, {
    position: 'fixed',
    top: `${topOffset}px`,
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '-1',
    backgroundImage: `url("${imageUrl.replace(/[\\"]/g, '\\$&')}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    pointerEvents: 'none',
  });
  if (!existingBg) document.body.prepend(bgDiv);

  const styleEl = existingStyle || document.createElement('style');
  styleEl.id = 'dpp-bg-style';
  styleEl.textContent = `
    #dpp-bg::after {
      content: '';
      position: absolute;
      inset: 0;
      background: var(--dpp-overlay-light);
      backdrop-filter: var(--dpp-blur);
      -webkit-backdrop-filter: var(--dpp-blur);
      pointer-events: none;
    }

    body.dpp-bg-active,
    body.dpp-bg-active #root,
    body.dpp-bg-active #__next {
      background: transparent !important;
    }

    body.dpp-bg-active #root > div,
    body.dpp-bg-active #__next > div {
      background: transparent !important;
    }

    body.dpp-bg-active #root > div > div,
    body.dpp-bg-active #__next > div > div {
      background: transparent !important;
    }

    body.dpp-bg-active [data-dpp-transparent] {
      background: transparent !important;
    }

    @media (prefers-color-scheme: dark) {
      #dpp-bg::after {
        background: var(--dpp-overlay-dark);
      }
    }
  `;
  if (!existingStyle) (document.head ?? document.documentElement)?.appendChild(styleEl);

  patchContainerBackgrounds();
}

// ─── Tool Block CSS (DeepSeek Thinking-inspired) ──────────────────

const BLOCK_CSS = `
/* ── 容器：轻量内联，无大卡片背景（对齐 DeepSeek 原生折叠条风格） ── */
.dpp-tool-block {
  margin-top: 8px;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', 'Segoe UI', sans-serif;
  font-size: 13px;
  color: var(--dpp-prompt-text, #1D1D1F);
}

/* ── Header：内联单行，muted 色，hover 变深 ─────────────────── */
.dpp-tb-header {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  color: var(--dpp-prompt-text-muted, #9CA3AF);
  font-size: 12px;
  line-height: 18px;
  transition: color 0.15s;
}
.dpp-tb-header:hover { color: var(--dpp-prompt-text, #1D1D1F); }
.dpp-tb-header:focus { outline: none; }

.dpp-tb-header-ripple { display: none; }

.dpp-tb-icon {
  width: 16px;
  height: 16px;
  color: var(--dpp-skill-color, #4D6BFE);
  flex-shrink: 0;
}

.dpp-tb-title {
  font-weight: 500;
  color: inherit;
  white-space: nowrap;
}

.dpp-tb-count { display: none; }

.dpp-tb-chevron {
  width: 12px;
  height: 12px;
  color: inherit;
  transition: transform 0.2s ease;
  margin-left: 2px;
  flex-shrink: 0;
}
.dpp-tool-block[data-collapsed="true"] .dpp-tb-chevron { transform: rotate(-90deg); }

/* ── Body：缩进、可折叠 ─────────────────────────────────────── */
.dpp-tb-body {
  /* 多次工具调用时固定高度并在内部滚动，避免超出部分被裁掉 */
  overflow-y: auto;
  overscroll-behavior: contain;
  transition: max-height 0.25s ease, opacity 0.2s ease, margin-top 0.2s ease;
  max-height: min(60vh, 520px);
  opacity: 1;
  padding-left: 20px;
  padding-right: 2px;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dpp-tb-body::-webkit-scrollbar { width: 6px; }
.dpp-tb-body::-webkit-scrollbar-thumb {
  background: var(--dpp-prompt-hint-border, #E5E7EB);
  border-radius: 3px;
}
.dpp-tool-block[data-collapsed="true"] .dpp-tb-body {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
  overflow: hidden;
}

/* ── Item：独立小卡片 ────────────────────────────────────────── */
.dpp-tb-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--dpp-prompt-hint-border, #F3F4F6);
  border-radius: 8px;
  background: var(--dpp-prompt-active-bg, #F7F8FA);
  font-size: 13px;
  line-height: 1.5;
}

.dpp-tb-dot-wrap {
  position: relative;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}

.dpp-tb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dpp-skill-color, #4D6BFE);
}
.dpp-tb-dot.is-done { background: var(--dpp-success-color, #10B981); }
.dpp-tb-dot.is-error { background: var(--dpp-danger-color, #EF4444); }

.dpp-tb-item-text {
  flex: 1;
  min-width: 0;
}

.dpp-tb-item-name {
  font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--dpp-skill-color, #4D6BFE);
}
.dpp-tb-item-name.is-done { color: var(--dpp-prompt-text, #1D1D1F); font-weight: 500; }
.dpp-tb-item-name.is-error { color: var(--dpp-danger-color, #EF4444); }

.dpp-tb-item-status {
  margin-left: 6px;
  font-size: 12px;
  color: var(--dpp-success-color, #10B981);
}
.dpp-tb-item-status.is-error { color: var(--dpp-danger-color, #EF4444); }

/* ── Detail 区块：独立可滚动区 ───────────────────────────────── */
.dpp-tb-item-detail {
  margin-top: 4px;
  padding: 6px 8px;
  max-height: min(52vh, 420px);
  border-radius: 8px;
  background: var(--dpp-skill-bg, #EEF1FF);
  color: var(--dpp-prompt-text-muted, #9CA3AF);
  font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow: auto;
  overflow-wrap: anywhere;
  overscroll-behavior: contain;
}

.dpp-tb-item-summary,
.dpp-tb-item-summary-empty { display: none; }

/* 兼容旧引用，避免外部逻辑引用 class 时样式塌陷 */
.dpp-tb-item-summary {
  font-size: 12px;
  color: var(--dpp-skill-color, #4D6BFE);
  margin-left: 6px;
}
`;
