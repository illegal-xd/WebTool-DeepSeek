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

const BLOCK_CLASS = 'dpp-tool-block';
const BLOCK_STYLE_ID = 'dpp-tool-block-css';
const STORAGE_PREFIX = 'dpp_tool_exec_';
const RECOGNIZED_TOOL_TAGS = [...DEFAULT_RECOGNIZED_TOOL_TAGS];
const ROUTE_RESTORE_WINDOW_MS = 4000;
const ASSISTANT_MESSAGE_SELECTORS = [
  '[class*="message"][class*="assistant"]',
  '[class*="ds-chat-message-assistant"]',
  '[class*="ds-msg-assistant"]',
  '[data-role="assistant"]',
];
const ASSISTANT_MESSAGE_SELECTOR = ASSISTANT_MESSAGE_SELECTORS.join(',');

interface DomToolCleanupState {
  insideToolBlock: boolean;
  activeNode: Text | null;
  visiblePrefix: string;
}

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
const assistantToolCleanupState = new WeakMap<Element, DomToolCleanupState>();
const pendingToolCleanupMessages = new Set<Element>();
let toolCleanupFrame: number | null = null;
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

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  runAt: 'document_start',
  async main() {
    await new Promise((r) => {
      if (document.readyState === 'complete' || document.readyState === 'interactive') r(undefined);
      else document.addEventListener('DOMContentLoaded', () => r(undefined), { once: true });
    });

    const [memories, skills, presets, activePreset, modelType, toolDescriptors] = await Promise.all([
      safeRuntimeSendMessage<Memory[]>({ type: 'GET_MEMORIES' }),
      safeRuntimeSendMessage<Skill[]>({ type: 'GET_SKILLS' }),
      safeRuntimeSendMessage<SystemPromptPreset[]>({ type: 'GET_PRESETS' }),
      safeRuntimeSendMessage<SystemPromptPreset | null>({ type: 'GET_ACTIVE_PRESET' }),
      safeRuntimeSendMessage<ModelType>({ type: 'GET_MODEL_TYPE' }),
      safeRuntimeSendMessage<ToolDescriptor[]>({ type: 'GET_TOOL_DESCRIPTORS' }),
    ]);

    currentToolDescriptors = toolDescriptors ?? [];
    syncToMainWorld(memories ?? [], skills ?? [], presets ?? [], activePreset, modelType, currentToolDescriptors);
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
          let result: ToolCardResult = { ok: true, summary: call.name };
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
          break;
        }
        case 'SET_ACTIVE_PRESET': {
          const id = event.data.id as string | null;
          await safeRuntimeSendMessage({ type: 'SET_ACTIVE_PRESET', payload: { id } });
          const [memories, skills, presets, activePreset, modelType, toolDescriptors] = await Promise.all([
            safeRuntimeSendMessage<Memory[]>({ type: 'GET_MEMORIES' }),
            safeRuntimeSendMessage<Skill[]>({ type: 'GET_SKILLS' }),
            safeRuntimeSendMessage<SystemPromptPreset[]>({ type: 'GET_PRESETS' }),
            safeRuntimeSendMessage<SystemPromptPreset | null>({ type: 'GET_ACTIVE_PRESET' }),
            safeRuntimeSendMessage<ModelType>({ type: 'GET_MODEL_TYPE' }),
            safeRuntimeSendMessage<ToolDescriptor[]>({ type: 'GET_TOOL_DESCRIPTORS' }),
          ]);
          currentToolDescriptors = toolDescriptors ?? [];
          syncToMainWorld(memories ?? [], skills ?? [], presets ?? [], activePreset, modelType, currentToolDescriptors);
          cleanRenderedToolCalls();
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
        syncToMainWorld(message.memories, message.skills, message.presets ?? [], message.activePreset, message.modelType, currentToolDescriptors);
        // Also refresh memory config in case it was changed
        safeRuntimeSendMessage<MemoryConfig>({ type: 'GET_MEMORY_CONFIG' }).then((cfg) => {
          if (cfg) {
            window.postMessage({ source: 'WebTool-DeepSeek-content', type: 'MEMORY_CONFIG_UPDATED', ...cfg });
          }
        });
        cleanRenderedToolCalls();
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
    setupToolCleanupObserver();
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

function syncToMainWorld(
  memories: Memory[],
  skills: Skill[],
  presets: SystemPromptPreset[],
  activePreset: SystemPromptPreset | null,
  modelType: ModelType,
  toolDescriptors: ToolDescriptor[],
  memoryTokenBudget?: number,
) {
  window.postMessage({
    source: 'WebTool-DeepSeek-content',
    type: 'SYNC_STATE',
    memories,
    skills,
    presets,
    activePreset,
    modelType,
    toolDescriptors,
    memoryTokenBudget,
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
      <span class="dpp-tb-count">1</span>
      <span class="dpp-tb-chevron" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    </div>
    <div class="dpp-tb-body">
      <div class="dpp-tb-item">
        <div class="dpp-tb-dot-wrap">
                              <span class="dpp-tb-dot"></span>
        </div>
        <span class="dpp-tb-item-name">${escapeHtml(call.name)}</span>
        <span class="dpp-tb-item-summary">执行中...</span>
      </div>
    </div>
  `;

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
  // Find the item that matches this call.name (first unfinished item)
  const items = block.querySelectorAll('.dpp-tb-item');
  let targetItem: HTMLElement | null = null;
  for (const item of items) {
    const nameEl = item.querySelector('.dpp-tb-item-name');
    if (nameEl && nameEl.textContent === call.name) {
      const summaryEl = item.querySelector('.dpp-tb-item-summary');
      if (summaryEl && summaryEl.textContent === '执行中...') {
        targetItem = item as HTMLElement;
        break;
      }
    }
  }

  if (!targetItem) {
    // If no matching unfinished item found (was already resolved from TOOL_CALL path),
    // try appending a new item
    addNewToolItem(block, call, result);
    return;
  }

  const summaryEl = targetItem.querySelector('.dpp-tb-item-summary') as HTMLElement;
  if (result.ok) {
    // Show the memory name (from detail) or the summary
    summaryEl.textContent = result.detail || result.summary;
  } else {
    summaryEl.textContent = result.summary;
  }

  const dot = targetItem.querySelector('.dpp-tb-dot') as HTMLElement;
  if (dot) {
    dot.classList.add(result.ok ? 'is-done' : 'is-error');
  }


  const nameEl = targetItem.querySelector('.dpp-tb-item-name') as HTMLElement;
  if (nameEl) {
    nameEl.classList.add(result.ok ? 'is-done' : 'is-error');
  }
}

function addNewToolItem(block: HTMLElement, call: ToolCall, result: ToolCardResult) {
  const body = block.querySelector('.dpp-tb-body');
  if (!body) return;

  const countEl = block.querySelector('.dpp-tb-count');
  if (countEl) {
    const count = parseInt(countEl.textContent || '1', 10) + 1;
    countEl.textContent = String(count);
  }

  const item = document.createElement('div');
  item.className = 'dpp-tb-item';
  item.innerHTML = `
    <div class="dpp-tb-dot-wrap">
                  <span class="dpp-tb-dot ${result.ok ? 'is-done' : 'is-error'}"></span>
    </div>
    <span class="dpp-tb-item-name ${result.ok ? 'is-done' : 'is-error'}">${escapeHtml(call.name)}</span>
    <span class="dpp-tb-item-summary">${escapeHtml(result.detail || result.summary)}</span>
  `;
  body.appendChild(item);
}

function addExecutingToolItem(block: HTMLElement, call: ToolCall) {
	  const body = block.querySelector('.dpp-tb-body');
	  if (!body) return;

	  const countEl = block.querySelector('.dpp-tb-count');
	  if (countEl) {
	    const count = parseInt(countEl.textContent || '1', 10) + 1;
	    countEl.textContent = String(count);
	  }

	  const item = document.createElement('div');
	  item.className = 'dpp-tb-item';
	  item.innerHTML = `
	    <div class="dpp-tb-dot-wrap">
	                  <span class="dpp-tb-dot"></span>
	    </div>
	    <span class="dpp-tb-item-name">${escapeHtml(call.name)}</span>
	    <span class="dpp-tb-item-summary">执行中...</span>
	  `;
	  body.appendChild(item);
	}

function renderEarlyToolPlaceholder(name: string, targetMessage?: Element) {
  const displayName = getToolDisplayName(name);
  if (earlyPlaceholderNames.includes(displayName)) return;

  const existingBlock = targetMessage?.querySelector<HTMLElement>(`.${BLOCK_CLASS}`) ?? null;
  const targetBlock = existingBlock
    ?? (currentToolBlock && document.contains(currentToolBlock) && (!targetMessage || targetMessage.contains(currentToolBlock))
      ? currentToolBlock
      : null);

  if (targetBlock) {
    addExecutingToolItem(targetBlock, { name: displayName, invocationName: name, payload: {}, raw: '' });
    earlyPlaceholderNames.push(displayName);
    return;
  }

  const block = createToolBlock({ name: displayName, invocationName: name, payload: {}, raw: '' });
  currentToolBlock = block;
  earlyPlaceholderNames.push(displayName);

  if (targetMessage instanceof HTMLElement) {
    targetMessage.appendChild(block);
  } else {
    const lastMsg = getLastAssistantMessage();
    if (lastMsg) {
      lastMsg.appendChild(block);
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

function getAssistantMessageRoot(el: Element): Element | null {
  return el.closest(ASSISTANT_MESSAGE_SELECTOR);
}

async function handleToolCall(call: ToolCall, callId: number) {
  // Reuse existing tool block for this conversation turn
  if (currentToolBlock && document.contains(currentToolBlock)) {
    const hasEarlyPlaceholder = consumeEarlyPlaceholder(call.name);
    if (!hasEarlyPlaceholder) {
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
  currentToolBlock = block;

  if (lastMsg) {
    lastMsg.appendChild(block);
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

async function finalizeResponse() {
  // Auto-collapse all blocks, persist, and sync memory list
  const blocks = document.querySelectorAll<HTMLElement>(`.${BLOCK_CLASS}`);
  const hadToolCall = blocks.length > 0;

  currentToolBlock = null;

  if (hadToolCall) {
    if (activeToolExecutions.size > 0) {
      await Promise.allSettled([...activeToolExecutions]);
    }
    persistToolExecutions();
    // Refresh memory list in the side panel
    await refreshMemoryList();
  }
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
      const summaryEl = item.querySelector('.dpp-tb-item-summary');
      const dot = item.querySelector('.dpp-tb-dot');
      const isDone = dot?.classList.contains('is-done') ?? false;
      const isError = dot?.classList.contains('is-error') ?? false;
      const summary = summaryEl?.textContent || '';
      if ((!isDone && !isError) || isPendingToolSummary(summary)) return;

      executions.push({
        name: nameEl?.textContent || '',
        result: { ok: isDone, summary, detail: '' },
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
  try {
    const key = getToolRestoreStorageKey();
    const data = await safeStorageLocalGet(key);
    if (!data) return;
    const stored = data[key];
    if (!Array.isArray(stored)) return;

    const records = (stored as ToolCallRestoreRecord[]).filter(isCurrentChatSessionRecord);
    const hydratedRecords = await hydrateToolCallRestoreRecords(records);
    // 本地持久化恢复通常发生在路由切换后，DOM 可能还没稳定；先内容匹配，延迟几轮后才允许索引兜底。
    renderRestoredToolBlocks(hydratedRecords, key, 0, {
      allowAssistantIndexFallback: true,
      assistantIndexFallbackMinAttempt: 3,
    });
  } catch {
    // ignore storage errors
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
    name: call.name,
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
  if (storageKey !== getToolRestoreStorageKey()) return;
  const pendingRecords: ToolCallRestoreRecord[] = [];
  const assistantMessages = findAssistantMessages();
  const usedMessages = new Set<HTMLElement>();
  const restorableRecords = records
    .map((record) => ({
      ...record,
      executions: record.executions.filter((exec) => !isPendingToolSummary(exec.result.summary) && !isPendingToolSummary(exec.result.detail || '')),
    }))
    .filter((record) => record.executions.length > 0);

  if (assistantMessages.length < restorableRecords.length && attempt < 20) {
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

  if (pendingRecords.length > 0 && attempt < 20) {
    setTimeout(() => renderRestoredToolBlocks(pendingRecords, storageKey, attempt + 1, options), 300);
  }
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

  const itemsHtml = record.executions.map((exec) => {
    const dotClass = exec.result.ok ? 'is-done' : 'is-error';
    const nameClass = exec.result.ok ? 'is-done' : 'is-error';
    return `<div class="dpp-tb-item">
        <div class="dpp-tb-dot-wrap">
          <span class="dpp-tb-dot ${dotClass}"></span>
        </div>
        <span class="dpp-tb-item-name ${nameClass}">${escapeHtml(exec.name)}</span>
        <span class="dpp-tb-item-summary">${escapeHtml(exec.result.detail || exec.result.summary)}</span>
      </div>`;
  }).join('');

  block.innerHTML = `
      <div class="dpp-tb-header" role="button" tabindex="0" aria-expanded="true">
        <div class="dpp-tb-header-ripple"></div>
        <span class="dpp-tb-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        </span>
        <span class="dpp-tb-title">工具调用</span>
        <span class="dpp-tb-count">${record.executions.length}</span>
        <span class="dpp-tb-chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </div>
      <div class="dpp-tb-body">${itemsHtml}</div>
    `;

  const header = block.querySelector('.dpp-tb-header') as HTMLElement;
  header.addEventListener('click', () => toggleBlockCollapse(block));
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleBlockCollapse(block);
    }
  });

  targetMessage.appendChild(block);
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
  return hasPotentialToolMarkup(text) || assistantToolCleanupState.get(assistantMessage)?.insideToolBlock === true;
}

function setupToolCleanupObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const parent = mutation.target.parentElement;
        const assistantMessage = parent ? getAssistantMessageRoot(parent) : null;
        if (!assistantMessage) continue;
        const text = mutation.target.textContent || '';
        if (shouldScheduleToolCleanup(assistantMessage, text)) {
          scheduleToolCleanupForMessage(assistantMessage);
        }
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement;
          const assistantMessage = parent ? getAssistantMessageRoot(parent) : null;
          if (!assistantMessage) continue;
          const text = node.textContent || '';
          if (shouldScheduleToolCleanup(assistantMessage, text)) {
            scheduleToolCleanupForMessage(assistantMessage);
          }
          continue;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const element = node as Element;
        if (isInsideToolBlock(element)) continue;

        const assistantMessage = getAssistantMessageRoot(element)
          ?? getFirstAssistantMessageDescendant(element);
        if (!assistantMessage) continue;

        if (shouldScheduleToolCleanup(assistantMessage, element.textContent || '')) {
          scheduleToolCleanupForMessage(assistantMessage);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
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
  if (foundTags) {
    assistantToolCleanupState.delete(assistantMessage);
  }

  const state = assistantToolCleanupState.get(assistantMessage) ?? {
    insideToolBlock: false,
    activeNode: null,
    visiblePrefix: '',
  };

  for (const node of targets) {
    const text = node.textContent || '';
    if (!text && !state.insideToolBlock) continue;

    const cleaned = removeToolMarkupFromText(text, state, node);
    if (cleaned.sawOpeningTag && Date.now() >= suppressToolPlaceholderUntil) {
      renderEarlyToolPlaceholder(cleaned.sawOpeningTag, assistantMessage);
    }
    if (cleaned.changed) {
      node.textContent = cleaned.text;
    }
  }

  cleanupEmptyMarkdownParagraphs(assistantMessage);

  if (state.insideToolBlock) {
    assistantToolCleanupState.set(assistantMessage, state);
  } else {
    assistantToolCleanupState.delete(assistantMessage);
  }
}

function cleanRenderedToolCallElements(assistantMessage: Element): Set<string> | null {
  const tagNames = new Map(getRecognizedToolTagNames().map((name) => [name.toLowerCase(), name]));
  if (tagNames.size === 0) return null;

  const foundTags = new Set<string>();
  assistantMessage.querySelectorAll('*').forEach((element) => {
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

function removeToolMarkupFromText(text: string, state: DomToolCleanupState, node: Text): {
  text: string;
  sawOpeningTag: string | null;
  changed: boolean;
} {
  let changed = false;
  const completeBlockRegex = createRecognizedToolTagRegex('complete');
  const openTagRegex = createRecognizedToolTagRegex('open');
  const closeTagRegex = createRecognizedToolTagRegex('close');

  let remaining = text.replace(completeBlockRegex, () => {
    changed = true;
    return '';
  });
  remaining = remaining.replace(/<｜DSML｜tool_calls>[\s\S]*?<\/｜DSML｜tool_calls>/g, () => {
    changed = true;
    return '';
  });

  let output = '';
  let cursor = 0;
  let sawOpeningTag: string | null = null;

  if (state.insideToolBlock && state.activeNode === node && state.visiblePrefix && remaining.startsWith(state.visiblePrefix)) {
    output = state.visiblePrefix;
    cursor = state.visiblePrefix.length;
  } else if (state.insideToolBlock) {
    const nextOpenMatch = remaining.match(openTagRegex);
    const nextEndMatch = remaining.match(closeTagRegex);
    if (nextOpenMatch && (!nextEndMatch || nextOpenMatch.index! < nextEndMatch.index!)) {
      state.insideToolBlock = false;
      state.activeNode = null;
      state.visiblePrefix = '';
    }
  }

  while (cursor < remaining.length) {
    if (state.insideToolBlock) {
      const endMatch = remaining.slice(cursor).match(closeTagRegex);
      if (!endMatch || endMatch.index === undefined) {
        cursor = remaining.length;
        changed = true;
        break;
      }
      cursor += endMatch.index + endMatch[0].length;
      state.insideToolBlock = false;
      state.activeNode = null;
      state.visiblePrefix = '';
      changed = true;
      continue;
    }

    const openMatch = remaining.slice(cursor).match(openTagRegex);
    if (!openMatch || openMatch.index === undefined) {
      output += remaining.slice(cursor);
      break;
    }

    output += remaining.slice(cursor, cursor + openMatch.index);
    sawOpeningTag = openMatch[1];
    cursor += openMatch.index + openMatch[0].length;
    state.insideToolBlock = true;
    state.activeNode = node;
    state.visiblePrefix = output;
    changed = true;
  }

  if (state.insideToolBlock && state.activeNode !== node) {
    state.activeNode = node;
    state.visiblePrefix = output;
  }

  return { text: output, sawOpeningTag, changed };
}

// ─── DOM Observer (background image patching + tool block) ────────

function setupDOMObserver() {
  let patchTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPathname = window.location.pathname;
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRestore = () => {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      restorePersistedToolBlocks();
    }, 200);
  };

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
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        needsPatch = true;
        const el = node as HTMLElement;
        if (isRouteRestoreWindowActive() && (getAssistantMessageRoot(el) || getFirstAssistantMessageDescendant(el))) {
          scheduleRestore();
        }
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

  observer.observe(document.body, { childList: true, subtree: true });
}

function hasPotentialToolMarkup(text: string): boolean {
  return getRecognizedToolTagNames().some((tag) => text.includes(`<${tag}>`) || text.includes(`</${tag}>`)) || /<｜DSML｜tool_calls>/.test(text);
}

function createRecognizedToolTagRegex(kind: 'open' | 'close' | 'complete'): RegExp {
  const names = getRecognizedToolTagNames().map(escapeRegExp).join('|');
  if (!names) return /$a/g;
  if (kind === 'open') return new RegExp(`<(${names})>`);
  if (kind === 'close') return new RegExp(`<\\/(${names})>`);
  return new RegExp(`<(${names})>\\s*\\{[\\s\\S]*?\\}\\s*<\\/\\1>`, 'g');
}

function getRecognizedToolTagNames(): string[] {
  const names = new Set(RECOGNIZED_TOOL_TAGS);
  for (const descriptor of currentToolDescriptors) {
    const invocationName = descriptor.invocationName.trim();
    if (invocationName) names.add(invocationName);
  }
  return [...names];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Tool Block CSS (DeepSeek Thinking-inspired) ──────────────────

const BLOCK_CSS = `
.dpp-tool-block {
  margin: 8px 0;
  background: #F0F5FF;
  border: 1px solid #D6E4FF;
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', 'Segoe UI', sans-serif;
  font-size: 13px;
  overflow: hidden;
  animation: dpp-tb-in 0.25s ease;
  transition: border-color 0.2s;
}
.dpp-tool-block:hover {
  border-color: #ADC6FF;
}

@keyframes dpp-tb-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Header (DeepSeek Thinking style) ────────────────────────── */
.dpp-tb-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  position: relative;
  overflow: hidden;
  transition: background 0.15s;
}
.dpp-tb-header:hover { background: rgba(77, 107, 254, 0.06); }
.dpp-tb-header:focus { outline: none; border-radius: 12px; }

.dpp-tb-header-ripple {
  display: none;
}

.dpp-tb-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: rgba(77, 107, 254, 0.1);
  color: #4D6BFE;
  flex-shrink: 0;
}

.dpp-tb-title {
  font-size: 13px;
  font-weight: 600;
  color: #1D1D1F;
  letter-spacing: 0.01em;
}

.dpp-tb-count {
  font-size: 10px;
  color: #4D6BFE;
  background: rgba(77, 107, 254, 0.1);
  border-radius: 10px;
  padding: 0 7px;
  line-height: 18px;
  font-weight: 600;
  min-width: 18px;
  text-align: center;
}

.dpp-tb-chevron {
  display: inline-flex;
  color: #8C8C8C;
  transition: transform 0.25s ease;
  flex-shrink: 0;
  margin-left: auto;
}
.dpp-tool-block[data-collapsed="true"] .dpp-tb-chevron { transform: rotate(-90deg); }

/* ── Body ────────────────────────────────────────────────────── */
.dpp-tb-body {
  max-height: 2000px;
  overflow: hidden;
  transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease;
  opacity: 1;
}
.dpp-tool-block[data-collapsed="true"] .dpp-tb-body {
  max-height: 0;
  opacity: 0;
}

/* ── Item Row ────────────────────────────────────────────────── */
.dpp-tb-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 14px 8px 14px;
  font-size: 13px;
  line-height: 1.5;
}
.dpp-tb-item:last-child {
  padding-bottom: 10px;
}

/* ── Blue Dot with Ripple ────────────────────────────────────── */
.dpp-tb-dot-wrap {
  position: relative;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dpp-tb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4D6BFE;
  position: relative;
  z-index: 1;
}

.dpp-tb-dot.is-error {
  background: #EF4444;
}

.dpp-tb-dot.is-error::before,
.dpp-tb-dot.is-error::after {
  background: #EF4444;
  animation-play-state: paused;
}

.dpp-tb-dot::before,
.dpp-tb-dot::after {
  position: absolute;
  content: '';
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: #4D6BFE;
  animation: dpp-ripple 4s linear 400ms infinite;
  pointer-events: none;
}
.dpp-tb-dot::after {
  animation: dpp-ripple 4s linear 200ms infinite;
  animation-delay: 2s;
}

@keyframes dpp-ripple {
  0% {
    transform: scale(1);
    opacity: 0.2;
  }
  100% {
    transform: scale(4);
    opacity: 0;
  }
}

/* ── Item Text ───────────────────────────────────────────────── */
.dpp-tb-item-name {
  font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #6B7280;
  flex-shrink: 0;
}
.dpp-tb-item-name.is-done {
  color: #1D1D1F;
  font-weight: 500;
}
.dpp-tb-item-name.is-error {
  color: #EF4444;
}

.dpp-tb-item-summary {
  font-size: 12px;
  color: #4D6BFE;
  font-weight: 500;
  margin-left: 2px;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}

/* ── Dark Mode ───────────────────────────────────────────────── */
@media (prefers-color-scheme: dark) {
  .dpp-tool-block {
    background: rgba(77, 107, 254, 0.06);
    border-color: rgba(77, 107, 254, 0.2);
  }
  .dpp-tool-block:hover {
    border-color: rgba(77, 107, 254, 0.35);
  }
  .dpp-tb-header:hover { background: rgba(77, 107, 254, 0.1); }
  .dpp-tb-icon {
    background: rgba(77, 107, 254, 0.15);
    color: #7C8FFF;
  }
  .dpp-tb-title { color: #E5E5E5; }
  .dpp-tb-count {
    color: #7C8FFF;
    background: rgba(77, 107, 254, 0.15);
  }
  .dpp-tb-chevron { color: #6B7280; }
  .dpp-tb-item-name { color: #9CA3AF; }
  .dpp-tb-item-name.is-done { color: #D1D5DB; }
  .dpp-tb-item-summary { color: #7C8FFF; }
}
`;
