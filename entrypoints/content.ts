import {
  deleteDeepSeekSession,
  getDeepSeekSessionHistory,
  listDeepSeekSessions,
  renameDeepSeekSession,
} from '../core/conversation/api';
import { DEFAULT_RECOGNIZED_TOOL_TAGS, createToolInvocationCatalog, createXmlToolCallRegex } from '../core/tool';
import type { MemoryConfig } from '../core/memory/config';
import { THEME_QUERY, normalizeThemePreference, resolveTheme, type ResolvedTheme, type ThemePreference } from '../core/theme';
import type { BackgroundConfig, Memory, ModelType, Skill, SystemPromptPreset, ToolCall, ToolCallHistoryRecord, ToolCardResult, ToolExecutionRecord, ToolCallRestoreRecord, ToolDescriptor } from '../core/types';
import type { TemplateOverrides } from '../core/templates/overrides';
import type { InjectionEvent } from '../core/inject/events';
import { buildAutoContinuationPrompt, type ContinuationToolResult } from '../core/templates/prompts';

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
let continuationRound = 0;
const MAX_CONTINUATION_ROUNDS = 8;
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
          await finalizeResponse();
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
          markRouteRestoreWindow();
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
    case 'DS_LIST_SESSIONS':
      return { ok: true, data: await listDeepSeekSessions() };
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
  document.head.appendChild(style);
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
  const items = block.querySelectorAll('.dpp-tb-item');
  let targetItem: HTMLElement | null = null;
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

  if (!targetItem) {
    addNewToolItem(block, call, result);
    return;
  }

  const statusEl = targetItem.querySelector('.dpp-tb-item-status') as HTMLElement | null;
  const displayedSummary = result.ok ? (result.detail || result.summary) : result.summary;
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
  body.appendChild(createToolBlockItem(getToolDisplayName(call.name), result.detail || result.summary, result.ok ? 'done' : 'error', formatToolResultDetail(result)));
  setToolBlockTitle(block, getToolBlockItemCount(block));
}

function addExecutingToolItem(block: HTMLElement, call: ToolCall) {
  const body = block.querySelector('.dpp-tb-body');
  if (!body) return;
  body.appendChild(createToolBlockItem(getToolDisplayName(call.name), '执行中...'));
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

  if (targetMessage instanceof HTMLElement) {
    getAssistantResponseHost(targetMessage).appendChild(block);
  } else {
    const lastMsg = getLastAssistantMessage();
    if (lastMsg) {
      getAssistantResponseHost(lastMsg).appendChild(block);
    } else {
      document.body.appendChild(block);
    }
  }
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
  return msgs.length > 0 ? msgs[msgs.length - 1] : null;
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
    if (hosts.length > 0) return hosts[hosts.length - 1];
  }
  // 回退：markdown 容器的父元素（包裹 markdown 的 content host）。
  // 思考模式下 DeepSeek 会渲染 reasoning + answer 两个 markdown 块，
  // 取最后一个（通常为最终回答块）以避免误挂到 reasoning 容器。
  const markdowns = message.querySelectorAll<HTMLElement>('.ds-markdown, [class*="ds-markdown"]');
  const lastMarkdown = markdowns.length > 0 ? markdowns[markdowns.length - 1] : null;
  if (lastMarkdown?.parentElement && lastMarkdown.parentElement !== message) {
    return lastMarkdown.parentElement;
  }
  // 最终回退：message root（与现状一致，不更差）。
  return message;
}

function getAssistantMessageRoot(el: Element): Element | null {
  return el.closest(ASSISTANT_MESSAGE_SELECTOR);
}

async function handleToolCall(call: ToolCall, callId: number) {
  // Reuse existing tool block for this conversation turn
  if (currentToolBlock && document.contains(currentToolBlock)) {
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

  // New conversation turn — clear previous tool call state
  pendingCallMap.clear();
  resolvedCallRaws.clear();
  earlyPlaceholderNames.length = 0;
  const lastMsg = getLastAssistantMessage();
  const block = createToolBlock(call);
  addExecutingToolItem(block, call);
  currentToolBlock = block;

  if (lastMsg) {
    getAssistantResponseHost(lastMsg).appendChild(block);
  } else {
    document.body.appendChild(block);
  }

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
    return result ?? { ok: false, summary: '执行失败', detail: '后台未返回执行结果' };
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
  currentTurnResults.push({
    name: getToolDisplayName(call.name),
    ok: result.ok,
    summary: result.summary,
    detail: result.detail,
  });
}

async function finalizeResponse() {
  // Auto-collapse all blocks, persist, and sync memory list
  const blocks = document.querySelectorAll<HTMLElement>(`.${BLOCK_CLASS}`);
  const hasBlocks = blocks.length > 0;
  const hadToolCallThisTurn = currentTurnResults.length > 0;

  currentToolBlock = null;

  if (hasBlocks) {
    if (activeToolExecutions.size > 0) {
      await Promise.allSettled([...activeToolExecutions]);
    }
    persistToolExecutions();
    if (hadToolCallThisTurn) {
      // Refresh memory list in the side panel
      await refreshMemoryList();
    }
  }

  // 自动续聊：本轮有工具调用时，构造工具结果回传 prompt 并自动发送下一轮。
  isAutoContinuing = false;
  if (hadToolCallThisTurn) {
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
    if (hasBlocks) {
      // React 可能在流完成后重渲染 message 子树移除 foreign block；
      // 延迟检查存活，丢失则从持久化记录重挂。
      const sessionId = getCurrentChatSessionId();
      setTimeout(() => {
        if (getCurrentChatSessionId() !== sessionId) return;
        reinsertLostBlocks();
      }, 1500);
    }
  }
}

/** 延迟存活检查：若流完成后的 React 重渲染移除了工具块，从持久化记录重挂。 */
function reinsertLostBlocks() {
  if (document.querySelectorAll(`.${BLOCK_CLASS}`).length > 0) return;
  restorePersistedToolBlocks();
}

/**
 * 自动续聊：设置挂起的 continuation prompt，然后在 DeepSeek 输入框填入简短标记
 * 并触发发送。fetch-hook 拦截该请求时会用挂起的 prompt 替换用户输入，
 * 用户气泡仅显示简短标记文本，工具结果在注入层不显示。
 */
async function triggerAutoContinue(prompt: string) {
  // 1. 通知 main-world 设置挂起的 continuation prompt。
  window.postMessage({
    source: 'WebTool-DeepSeek-content',
    type: 'SET_CONTINUATION_PROMPT',
    prompt,
  }, '*');

  // 2. 标记续聊中（TURN_START 时不重置续聊计数）。
  isAutoContinuing = true;

  // 3. 在输入框填入简短标记并发送。
  await fillAndSendPrompt('继续');
}

/**
 * 填入 DeepSeek 输入框并触发发送。
 * 优先用 native setter 设值并派发 input 事件触发 React 状态更新；
 * 发送优先尝试发送按钮点击，回退到 Enter 键事件。
 */
async function fillAndSendPrompt(text: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea#chat-input')
    ?? document.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) return;

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

  // 尝试点击发送按钮。
  const sendBtn = findSendButton();
  if (sendBtn) {
    sendBtn.click();
    return;
  }

  // 回退：模拟 Enter 键提交。
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
}

/** 查找 DeepSeek 发送按钮。选择器可能随版本变化，覆盖多种候选结构。 */
function findSendButton(): HTMLElement | null {
  const candidates: Array<string> = [
    'div[role="button"] > div > svg',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    '.ds-icon-button[type="button"]',
    'div[role="button"][aria-label*="发送"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (!el) continue;

    // SVG 命中时向上解析真实可点击元素，避免对 SVGElement 调用不存在的 click()。
    const clickTarget = el.closest<HTMLElement>('button, [role="button"]');
    if (clickTarget instanceof HTMLElement) return clickTarget;
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

function appendRestoredToolBlock(targetMessage: HTMLElement, record: ToolCallRestoreRecord) {
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
    body?.appendChild(createToolBlockItem(exec.name, exec.result.detail || exec.result.summary, exec.result.ok ? 'done' : 'error', detail));
  }

  const header = block.querySelector('.dpp-tb-header') as HTMLElement;
  header.addEventListener('click', () => toggleBlockCollapse(block));
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleBlockCollapse(block);
    }
  });

  getAssistantResponseHost(targetMessage).appendChild(block);
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
  if (!existingStyle) document.head.appendChild(styleEl);

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
  overflow: hidden;
  transition: max-height 0.25s ease, opacity 0.2s ease, margin-top 0.2s ease;
  max-height: 500px;
  opacity: 1;
  padding-left: 20px;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dpp-tool-block[data-collapsed="true"] .dpp-tb-body {
  max-height: 0;
  opacity: 0;
  margin-top: 0;
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
