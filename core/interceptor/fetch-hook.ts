import { CONTINUATION_MARKER, DEEPSEEK_API_URL, MEMORY_TOKEN_BUDGET } from '../constants';
import { INSTRUCTION_SEPARATOR, MEMORY_BACKGROUND_TEMPLATE } from '../templates';
import { resolvePresetMention } from '../preset/mention';
import { TEMPLATE_KEYS, type TemplateOverrides } from '../templates/overrides';
import { createInjectionEvent, type InjectionEvent, type InjectionKind } from '../inject/events';
import { DEFAULT_RECOGNIZED_TOOL_TAGS, createToolInvocationCatalog, hasXmlToolMarker } from '../tool';
import type { Memory, ModelType, SystemPromptPreset, ToolCall, ToolCardResult, ToolCallRestoreRecord, Skill, ToolDescriptor } from '../types';
import { buildAugmentedPrompt, buildCustomMemoryPrompt, buildInstructionOnlyPrompt, buildLightweightMemoryPrompt, fillTemplate, renderUserInputBlock, resolveTemplate, setTemplateOverrides } from '../memory/injector';
import { findPresetForMemory, memoryPresetOverlap, PRESET_LINK_THRESHOLD } from '../memory/preset-link';
import { parseSkillCommand } from '../skill/parser';
import { extractTextFromParsed, isStreamFinishedFromParsed, parseSSEChunk, parseSSEData } from './sse-parser';
import { extractToolCalls, stripToolCalls } from './tool-parser';
import { createToolMarkupStreamFilter, type ToolMarkupStreamFilter } from './tool-stream-filter';

const API_PATH = new URL(DEEPSEEK_API_URL).pathname;
const HISTORY_PATH = '/api/v0/chat/history_messages';
const SINGLE_INJECTION_STORAGE_KEY = 'webtool_deepseek_single_injection_sessions';
const PENDING_SINGLE_INJECTION_SESSION = '__pending_chat_session__';

/** 会话级注入去重记录：同一对话后续轮次跳过已注入的系统模板/预设/工具 schema。 */
interface SessionInjectionRecord {
  systemTemplateInjected: boolean;
  presetInjected: boolean;
  presetContentHash: string | null;
  injectedMemoryIds: Set<number>;
}

interface HookState {
  memories: Memory[];
  skills: Skill[];
  presets: SystemPromptPreset[];
  modelType: ModelType;
  toolDescriptors: ToolDescriptor[];
  recognizedToolTags: string[];
  memoryTokenBudget: number;
  singleMemoryInjection: boolean;
  customMemoryEnabled: boolean;
  customMemoryPrompt: string;
  templateOverrides?: TemplateOverrides;
  _lastChatSessionId: string | null;
  _singleInjectionSessionIds: Set<string>;
  _sessionInjectionRecords: Map<string, SessionInjectionRecord>;
  /** 当前对话上下文中已注入过「完整内容」的记忆 id（供 `#` 弹窗标记「已注入」）。 */
  _injectedMemoryIdsForContext: Set<number>;
  /** 当前对话已出现过（索引或全文）的记忆 id，用于自动注入跨轮去重。 */
  _contextIndexedMemoryIds: Set<number>;
  /** 本对话通过 memory_get 读过正文的记忆 id：下一轮补注入全文，避免重复调用。 */
  _memoryContentReadIds: Set<number>;
  onToolCall: (call: ToolCall) => void;
  /** aborted=true 表示流被中断或请求失败：上层据此禁止自动续聊。 */
  onResponseComplete: (fullText: string, meta?: { aborted?: boolean }) => void;
  onTurnStart: () => void;
  /** 每轮用户输入（已剥离 @mention）回调，供被动记忆候选提炼使用。 */
  onUserPrompt: (prompt: string) => void;
  /**
   * @Deprecated 2026-11-20 上下文胶囊已停用，该集合恒为空。
   * 保留字段以便功能回退。
   */
  excludedMemoryIds: Set<number>;
  onMemoriesUsed: (ids: number[]) => void;
  onToolCallExecuted: (call: ToolCall) => Promise<ToolCardResult>;
  onToolCallsRestored: (records: ToolCallRestoreRecord[]) => void;
  onSkillUsed: (name: string) => void;
  onInjectionEvent?: (event: InjectionEvent) => void;
  /** 续聊请求挂起的 continuation prompt；非空时跳过常规注入并以此替换用户输入。 */
  pendingContinuationPrompt: string | null;
  /** 续聊 prompt 的设置时间：用于丢弃超时未发送的残留（否则会污染后续新对话）。 */
  pendingContinuationAt: number;
}

let hookState: HookState = {
  memories: [],
  skills: [],
  presets: [],
  modelType: null,
  toolDescriptors: [],
  recognizedToolTags: [...DEFAULT_RECOGNIZED_TOOL_TAGS],
  memoryTokenBudget: MEMORY_TOKEN_BUDGET,
  singleMemoryInjection: false,
  customMemoryEnabled: false,
  customMemoryPrompt: '',
  _lastChatSessionId: null,
  _singleInjectionSessionIds: new Set(),
  _sessionInjectionRecords: new Map(),
  _injectedMemoryIdsForContext: new Set(),
  _contextIndexedMemoryIds: new Set(),
  _memoryContentReadIds: new Set(),
  onToolCall: () => {},
  onResponseComplete: () => {},
  onTurnStart: () => {},
  onUserPrompt: () => {},
  excludedMemoryIds: new Set(),
  onMemoriesUsed: () => {},
  onToolCallExecuted: async () => ({ ok: true, summary: '已识别' }),
  onToolCallsRestored: () => {},
  onSkillUsed: () => {},
  pendingContinuationPrompt: null,
  pendingContinuationAt: 0,
};

function readSingleInjectionSessionIds(): Set<string> {
  try {
    // 只持久化“当前标签页中已普通注入过的真实对话 id”，刷新页面后仍能避免重复注入。
    const raw = window.sessionStorage.getItem(SINGLE_INJECTION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0));
  } catch {
    return new Set();
  }
}

function saveSingleInjectionSessionIds() {
  try {
    const ids = [...hookState._singleInjectionSessionIds].filter((id) => id !== PENDING_SINGLE_INJECTION_SESSION);
    window.sessionStorage.setItem(SINGLE_INJECTION_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // ignore storage errors
  }
}

function markSingleInjectionSession(sessionId: string) {
  hookState._singleInjectionSessionIds.add(sessionId);
  if (sessionId !== PENDING_SINGLE_INJECTION_SESSION) {
    saveSingleInjectionSessionIds();
  }
}

function deleteSingleInjectionSession(sessionId: string) {
  hookState._singleInjectionSessionIds.delete(sessionId);
  if (sessionId !== PENDING_SINGLE_INJECTION_SESSION) {
    saveSingleInjectionSessionIds();
  }
}

function getSingleInjectionSessionId(chatSessionId: string | null): string {
  return chatSessionId ?? PENDING_SINGLE_INJECTION_SESSION;
}

/** 预设内容指纹：变更后需重新注入。 */
function presetContentHash(preset: SystemPromptPreset | null): string | null {
  if (!preset) return null;
  return `${preset.id ?? preset.name}:${preset.content.length}`;
}

/** 取/建会话注入去重记录。 */
function getOrCreateSessionRecord(sessionId: string): SessionInjectionRecord {
  let record = hookState._sessionInjectionRecords.get(sessionId);
  if (!record) {
    record = {
      systemTemplateInjected: false,
      presetInjected: false,
      presetContentHash: null,
      injectedMemoryIds: new Set(),
    };
    hookState._sessionInjectionRecords.set(sessionId, record);
  }
  return record;
}

/**
 * 诊断开关：页面 localStorage 设置 `webtool_debug=1` 后，
 * 在 Console 输出注入路径 / 工具描述符数量 / 识别到的工具调用，便于定位「不渲染」。
 */
function debugLog(event: string, detail: Record<string, unknown>): void {
  try {
    if (window.localStorage.getItem('webtool_debug') !== '1') return;
    console.info(`[WebTool-DeepSeek] ${event}`, detail);
  } catch {
    // 诊断日志失败不影响主流程
  }
}

/** 自动续聊 prompt 的有效期：超时未发送则丢弃，避免回放到新对话。 */
const CONTINUATION_PROMPT_TTL_MS = 10_000;

const CONTEXT_INJECTED_STORAGE_KEY = 'webtool_deepseek_context_injected_memory_ids';
const MAX_PERSISTED_CONTEXT_SESSIONS = 10;

/**
 * 已注入「完整内容」的上下文记录。
 *
 * 记忆全文一旦注入，其内容就留在本对话历史里，模型后续可直接读到；
 * 再次注入只是浪费预算。这里记录「本对话已注入过全文的记忆」，
 * 供 `#` 弹窗标记为「已注入」并禁止勾选。仅索引注入（只有标题）不算。
 */
function markMemoriesInjected(ids: readonly number[]): void {
  if (ids.length === 0) return;
  for (const id of ids) hookState._injectedMemoryIdsForContext.add(id);
  persistContextInjections();
}

/** 记录本对话已出现过的记忆 id（索引或全文），用于自动注入跨轮去重。 */
function rememberContextMemoryIds(ids: readonly number[]): void {
  for (const id of ids) hookState._contextIndexedMemoryIds.add(id);
}

/**
 * 记录 `memory_get` 已读到正文的记忆（按 key = ID / #ID / 标题匹配）。
 *
 * 只查看记忆时不会自动续聊，正文需要在下一次请求时补注入上下文，
 * 否则 agent 只能看到「（仅标题）」索引，会反复调用 memory_get。
 */
export function recordMemoryToolRead(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  const numeric = Number(trimmed.replace(/^#/, ''));
  const lower = trimmed.toLowerCase();
  const found = (Number.isFinite(numeric) && numeric > 0
    ? hookState.memories.find((memory) => memory.id === numeric)
    : undefined)
    ?? hookState.memories.find((memory) => memory.name.toLowerCase() === lower)
    ?? hookState.memories.find((memory) => memory.name.toLowerCase().startsWith(lower));
  if (found?.id != null) hookState._memoryContentReadIds.add(found.id);
}

/**
 * 自动注入的记忆只对「静默记忆」标记已注入：非静默记忆只有标题索引，
 * 正文仍需 memory_get 读取，不能禁止用户在 `#` 弹窗中再选它注入全文。
 */
function markMemoriesInjectedForContent(ids: readonly number[]): void {
  const fullIds = ids.filter((id) => hookState.memories.some((memory) => memory.id === id && memory.silentInject === true));
  if (fullIds.length > 0) markMemoriesInjected(fullIds);
}

function persistContextInjections(): void {
  const sessionId = hookState._lastChatSessionId;
  if (!sessionId) return;
  try {
    const raw = window.sessionStorage.getItem(CONTEXT_INJECTED_STORAGE_KEY);
    const store = raw ? JSON.parse(raw) as Record<string, number[]> : {};
    store[sessionId] = [...hookState._injectedMemoryIdsForContext];
    const keys = Object.keys(store);
    if (keys.length > MAX_PERSISTED_CONTEXT_SESSIONS) {
      for (const key of keys.slice(0, keys.length - MAX_PERSISTED_CONTEXT_SESSIONS)) delete store[key];
    }
    window.sessionStorage.setItem(CONTEXT_INJECTED_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 持久化失败不影响注入
  }
}

/** 当前地址栏所在对话的 session id；新对话页没有 `/chat/s/{id}`，返回 null。 */
function getRouteChatSessionId(): string | null {
  const match = window.location.pathname.match(/\/chat\/s\/([^/?#]+)/);
  return match?.[1] ?? null;
}

/** 当前对话上下文中已注入的记忆 id（内存 + 本标签页持久化）。 */
export function getInjectedMemoryIdsForContext(): number[] {
  // 新对话页还没有 session id：上下文是空的。若继续回退到
  // `_lastChatSessionId`，会继承上一个对话的注入记录，把旧记忆标成
  // 「已注入」而在新对话里无法选择。
  const routeSessionId = getRouteChatSessionId();
  if (!routeSessionId) return [];
  const ids = new Set<number>();
  // 内存集合只在它确实属于当前对话时使用，避免切对话瞬间串台。
  if (hookState._lastChatSessionId === routeSessionId) {
    for (const id of hookState._injectedMemoryIdsForContext) ids.add(id);
  }
  try {
    const raw = window.sessionStorage.getItem(CONTEXT_INJECTED_STORAGE_KEY);
    const store = raw ? JSON.parse(raw) as Record<string, number[]> : {};
    for (const id of store[routeSessionId] ?? []) ids.add(id);
  } catch {
    // 忽略损坏的持久化数据
  }
  return [...ids];
}

function shouldUseSingleMemoryInjection(): boolean {
  return hookState.singleMemoryInjection;
}

function syncConcreteSingleInjectionSession(chatSessionId: string | null, hasConcreteParentMessage: boolean) {
  if (chatSessionId !== null && hasConcreteParentMessage) {
    bindPendingSingleInjectionSession(chatSessionId);
  }
}

/** 上报一次注入事件（记忆/预设/提示词/MCP），供 sidepanel 时间轴展示。 */
function emitInjectionEvent(kind: InjectionKind, title: string, detail?: string, payload?: string) {
  const event = createInjectionEvent({
    kind,
    title,
    ...(detail ? { detail } : {}),
    ...(payload ? { payload } : {}),
    sessionId: hookState._lastChatSessionId,
  });
  try {
    hookState.onInjectionEvent?.(event);
  } catch {
    // 事件上报失败不影响注入主流程
  }
}

/** 当前工具描述符中是否包含 MCP 工具。 */
/** 收集与活动预设高度重合的记忆 id（供注入标注用）。 */
function collectPresetRelatedMemoryIds(memories: Memory[], preset: SystemPromptPreset): Record<string, number[]> {
  const ids: number[] = [];
  for (const memory of memories) {
    if (memory.id == null) continue;
    if (memoryPresetOverlap(memory, preset) >= PRESET_LINK_THRESHOLD) ids.push(memory.id);
  }
  return ids.length > 0 ? { [preset.name]: ids } : {};
}

function hasMcpTools(): boolean {
  return hookState.toolDescriptors.some((descriptor) => descriptor.provider?.kind === 'mcp');
}

function shouldSkipSingleMemoryInjection(isFirstMessage: boolean, sessionId: string): boolean {
  return !isFirstMessage && shouldUseSingleMemoryInjection() && hookState._singleInjectionSessionIds.has(sessionId);
}

function recordSingleMemoryInjection(sessionId: string) {
  if (shouldUseSingleMemoryInjection()) {
    markSingleInjectionSession(sessionId);
  }
}

export function bindPendingSingleInjectionSession(sessionId: string) {
  // 新对话首条请求通常还没有 chat_session_id，路由更新后再把 pending 标记绑定到真实会话。
  if (!hookState._singleInjectionSessionIds.has(PENDING_SINGLE_INJECTION_SESSION)) return;
  markSingleInjectionSession(sessionId);
  deleteSingleInjectionSession(PENDING_SINGLE_INJECTION_SESSION);
  // 同步迁移 pending 的去重记录到真实会话 id。
  const pending = hookState._sessionInjectionRecords.get(PENDING_SINGLE_INJECTION_SESSION);
  if (pending) {
    hookState._sessionInjectionRecords.set(sessionId, pending);
    hookState._sessionInjectionRecords.delete(PENDING_SINGLE_INJECTION_SESSION);
  }
}

let storedHistoryRaw: { json: unknown; sessionId: string | null } | null = null;

interface ToolStreamFilterState {
  sseRemainder: string;
  textFilter: ToolMarkupStreamFilter;
}

export function updateHookState(partial: Partial<HookState>) {
  hookState = { ...hookState, ...partial };
  // 模板覆盖状态同步到注入器（内存态，避免注入路径读 storage）。
  if (partial.templateOverrides !== undefined || !hasAppliedOverrides) {
    applyTemplateOverrides();
  }
}

let hasAppliedOverrides = false;

function applyTemplateOverrides() {
  const overrides = hookState.templateOverrides ?? {};
  setTemplateOverrides(overrides);
  hasAppliedOverrides = true;
}

/** Re-process the stored raw history response with the current (now-populated) tool descriptors. */
export async function reprocessStoredHistory(): Promise<void> {
  if (!storedHistoryRaw) return;
  const descriptors = hookState.toolDescriptors;
  const mcpCount = descriptors.filter((d) => d.provider?.kind === 'mcp').length;
  if (mcpCount === 0) return;
  try {
    const json = JSON.parse(JSON.stringify(storedHistoryRaw.json));
    const { records } = stripToolCallsFromHistoryInternal(json, storedHistoryRaw.sessionId);
    if (records.length > 0) {
      hookState.onToolCallsRestored(records);
    }
    storedHistoryRaw = null;
  } catch {
    // skip reprocessing errors silently
  }
}

const HOOK_INSTALLED_FLAG = '__webtoolDeepseekFetchHookInstalled';

export function installFetchHook() {
  // 幂等守卫：重复安装会让一次响应触发两次 onResponseComplete，进而重复自动续聊。
  const scope = window as unknown as Record<string, unknown>;
  if (scope[HOOK_INSTALLED_FLAG] === true) return;
  scope[HOOK_INSTALLED_FLAG] = true;

  hookState._singleInjectionSessionIds = readSingleInjectionSessionIds();
  hookFetch();
  hookXHR();
  hookHistoryFetch();
  hookHistoryXHR();
  hookIndexedDB();
}

/**
 * 记录页面自身请求使用的 X-App-Version，供内容脚本直连私有接口时对齐真实版本，
 * 避免用写死的版本号把自己标记成「非官方客户端」。
 */
function recordAppVersionFromHeaders(headers: HeadersInit | undefined): void {
  if (!headers) return;
  try {
    let value: string | null = null;
    if (headers instanceof Headers) {
      value = headers.get('X-App-Version');
    } else if (Array.isArray(headers)) {
      value = headers.find(([key]) => String(key).toLowerCase() === 'x-app-version')?.[1] ?? null;
    } else {
      const record = headers as Record<string, string>;
      value = record['X-App-Version'] ?? record['x-app-version'] ?? null;
    }
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.trim().slice(0, 32);
      if (document.documentElement.dataset.webtoolDsVersion !== normalized) {
        document.documentElement.dataset.webtoolDsVersion = normalized;
      }
    }
  } catch {
    // 捕获失败不影响请求本身
  }
}

function hookFetch() {
  const savedFetch = window.fetch;

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.includes('chat.deepseek.com')) {
      recordAppVersionFromHeaders(input instanceof Request ? input.headers : init?.headers);
    }

    if (!isChatCompletionURL(url) || !init?.body) {
      return savedFetch.call(this, input, init);
    }

    const modified = modifyRequestBody(init.body as string);
    if (!modified) return savedFetch.call(this, input, init);

    init = { ...init, body: modified };
    hookState.onTurnStart();
    return interceptFetchResponse(savedFetch.call(this, input, init));
  };
}

function hookXHR() {
  const xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    xhrUrls.set(this, typeof url === 'string' ? url : url.href);
    return origOpen.apply(this, [method, url as string, ...rest] as Parameters<typeof origOpen>);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    if (String(name).toLowerCase() === 'x-app-version' && typeof value === 'string' && value.trim()) {
      document.documentElement.dataset.webtoolDsVersion = value.trim().slice(0, 32);
    }
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = xhrUrls.get(this);
    if (url && isChatCompletionURL(url) && typeof body === 'string') {
      const modified = modifyRequestBody(body);
      if (modified) {
        hookState.onTurnStart();
        setupXHRResponseInterceptor(this);
        return origSend.call(this, modified);
      }
    }
    return origSend.call(this, body);
  };
}

function isChatCompletionURL(url: string): boolean {
  return url.includes(API_PATH);
}

interface MemoryCommandContext {
  memories: Memory[];
  args: string;
  presetInstruction: string;
  effectivePreset: SystemPromptPreset | null;
  thinkingEnabled: boolean;
}

/** `#记忆名` 显式手动注入路径：记忆背景 + （可选）预设关联 + 用户正文。 */
function applyMemoryCommand(body: Record<string, unknown>, context: MemoryCommandContext): string {
  const { memories, args, presetInstruction, effectivePreset, thinkingEnabled } = context;

  const memoryInstruction = memories
    .map((memory) => wrapMemoryInput(memory.name, memory.content, ''))
    .join('\n\n');
  // 任一记忆内容与当前预设高度重合时，关联注入对应的预设指令。
  const linkedPreset = memories
    .map((memory) => findPresetForMemory(memory, effectivePreset ? [effectivePreset] : []))
    .find((preset): preset is SystemPromptPreset => Boolean(preset)) ?? null;
  const linkedInstruction = linkedPreset
    ? `<关联预设：${linkedPreset.name}（记忆内容与该预设高度重合，请结合其指令回答）>\n\n${linkedPreset.content}`
    : '';

  const { augmented } = buildAugmentedPrompt(args, [], {
    thinkingEnabled,
    tokenBudget: hookState.memoryTokenBudget,
    toolDescriptors: hookState.toolDescriptors,
    instructionBlock: joinInstructionBlocks(presetInstruction, memoryInstruction, linkedInstruction),
  });

  body.prompt = augmented;
  const usedIds = memories.map((memory) => memory.id).filter((id): id is number => id != null);
  if (usedIds.length > 0) {
    hookState.onMemoriesUsed(usedIds);
    markMemoriesInjected(usedIds);
  }
  emitInjectionEvent(
    'memory',
    `记忆注入：${memories.map((memory) => memory.name).join('、')}`,
    linkedPreset
      ? `已关联预设「${linkedPreset.name}」`
      : (hasMcpTools() ? '含 MCP 工具描述符' : undefined),
    augmented,
  );
  return JSON.stringify(body);
}

export function modifyRequestBody(bodyStr: string): string | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    return null;
  }

  const rawPrompt = (body.prompt as string) || '';
  if (!rawPrompt) return null;

  // 会话标识与会话级状态必须先确定：后续记忆选择依赖「本对话已注入」集合。
  const chatSessionId = typeof body.chat_session_id === 'string' ? body.chat_session_id : null;
  const hasConcreteParentMessage = body.parent_message_id !== null && body.parent_message_id !== undefined;
  const isNewConversation = !hasConcreteParentMessage;

  // 新对话：清空上一个对话的注入状态（尤其是 sessionId 未知时的 PENDING 槽位），
  // 否则会继承「已注入过」的判定，导致静默注入/首轮注入被跳过。
  if (isNewConversation) {
    hookState._sessionInjectionRecords.delete(PENDING_SINGLE_INJECTION_SESSION);
    hookState._singleInjectionSessionIds.delete(PENDING_SINGLE_INJECTION_SESSION);
    hookState._injectedMemoryIdsForContext.clear();
    hookState._contextIndexedMemoryIds.clear();
    hookState._memoryContentReadIds.clear();
    hookState._lastChatSessionId = chatSessionId;
  } else if (chatSessionId !== null && chatSessionId !== hookState._lastChatSessionId) {
    // 切换到另一个已有对话：上下文里已注入的记忆集合重新开始累计。
    hookState._lastChatSessionId = chatSessionId;
    hookState._injectedMemoryIdsForContext.clear();
    hookState._contextIndexedMemoryIds.clear();
    hookState._memoryContentReadIds.clear();
  }

  // 自动续聊请求：用挂起的 continuation prompt 替换用户输入，跳过常规记忆/预设注入。
  // 仅当请求 prompt 就是自动填入的占位标记时才替换——用户自己输入的内容永不被顶替。
  if (hookState.pendingContinuationPrompt) {
    const fresh = Date.now() - hookState.pendingContinuationAt < CONTINUATION_PROMPT_TTL_MS;
    const isContinuationMarker = rawPrompt.trim() === CONTINUATION_MARKER;
    if (fresh && isContinuationMarker && !isNewConversation) {
      body.prompt = hookState.pendingContinuationPrompt;
      hookState.pendingContinuationPrompt = null;
      hookState.pendingContinuationAt = 0;
      return JSON.stringify(body);
    }
    hookState.pendingContinuationPrompt = null;
    hookState.pendingContinuationAt = 0;
  }

  // 输入框开头的 `@预设名` 只对当条消息生效（与 /skill、#记忆 一致，不保留任何激活状态）：
  // 命中则剥离 mention 并把该预设用于本条消息；未命中/纯 mention 则原样保留。
  const mention = resolvePresetMention(rawPrompt, hookState.presets);
  const originalPrompt = mention?.rest ?? rawPrompt;
  const effectivePreset = mention?.preset ?? null;
  const presetInstruction = effectivePreset?.content ?? '';

  // 上下文胶囊的临时排除：在注入前剔除，被剔除条目的预算会让给其他记忆。
  const availableMemories = hookState.excludedMemoryIds.size > 0
    ? hookState.memories.filter((memory) => memory.id == null || !hookState.excludedMemoryIds.has(memory.id))
    : hookState.memories;

  // 自动注入：本对话未出现过的记忆全部以「索引」注入（标题 + id + 标签），
  // 静默记忆除外——它们在渲染时带完整正文。正文由 memory_get 按需读取。
  const injectedIds = getInjectedMemoryIdsForContext();
  const autoInjectMemories = availableMemories.filter(
    (memory) => memory.id == null
      || (!hookState._contextIndexedMemoryIds.has(memory.id) && !injectedIds.includes(memory.id)),
  );
  // 增强回调（被动记忆捕获）失败不得影响注入主流程与工具 schema 注入。
  try {
    hookState.onUserPrompt(originalPrompt);
  } catch {
    // ignore
  }
  debugLog('request', {
    tools: hookState.toolDescriptors.length,
    memories: hookState.memories.length,
    customMemory: hookState.customMemoryEnabled,
    promptChars: originalPrompt.length,
  });

  const thinkingEnabled = body.thinking_enabled === true;

  // @Deprecated 2026-11-20 Expert 模式已停用：不再覆盖请求体的 model_type，
  // 交由 DeepSeek 页面自身选择。保留 hookState.modelType 字段以便回退。
  // if (hookState.modelType) {
  //   body.model_type = hookState.modelType;
  // }

  const memInvocation = hookState.customMemoryEnabled ? null : parseMemoryCommand(originalPrompt, availableMemories);
  // `#记忆名` 是显式手动注入路径，不参与普通自动记忆的单次去重。
  if (memInvocation) {
    return applyMemoryCommand(body, {
      memories: memInvocation.memories,
      args: memInvocation.args,
      presetInstruction,
      effectivePreset,
      thinkingEnabled,
    });
  }

  const invocation = parseSkillCommand(originalPrompt);
  // Skill/预设只有在自身开启记忆时才拼接默认记忆系统提示词；否则只拼接选中的指令块。
  if (invocation) {
    const resolved = resolveSkills(invocation.skillName, invocation.args);
    if (resolved) {
      if (hookState.customMemoryEnabled) {
        const { augmented } = buildCustomMemoryModePrompt(resolved.userInput, presetInstruction, resolved.instructions);
        body.prompt = augmented;
        hookState.onSkillUsed(invocation.skillName);
        emitInjectionEvent('skill', `技能注入：/${invocation.skillName}`, '自定义记忆模式', augmented);
        return JSON.stringify(body);
      }

      const instructionBlock = joinInstructionBlocks(presetInstruction, resolved.instructions);
      const useMemoryPrompt = shouldUseMemoryPromptForSkill(resolved, effectivePreset);
      const { augmented, usedMemoryIds } = buildPromptForInstructionMode(
        resolved.userInput,
        instructionBlock,
        useMemoryPrompt,
        useMemoryPrompt ? resolveTargetMemories(collectMemorySources(resolved, effectivePreset)) : [],
        thinkingEnabled,
      );

      body.prompt = augmented;
      if (usedMemoryIds.length > 0) {
        hookState.onMemoriesUsed(usedMemoryIds);
        rememberContextMemoryIds(usedMemoryIds);
        markMemoriesInjectedForContent(usedMemoryIds);
      }
      hookState.onSkillUsed(invocation.skillName);
      emitInjectionEvent('skill', `技能注入：/${invocation.skillName}`, usedMemoryIds.length > 0 ? `关联记忆 ${usedMemoryIds.length} 条` : undefined, augmented);
      return JSON.stringify(body);
    }
  }

  let targetMemories = autoInjectMemories;

  if (hookState.customMemoryEnabled) {
    const { augmented } = buildCustomMemoryModePrompt(originalPrompt, presetInstruction);
    body.prompt = augmented;
    emitInjectionEvent('prompt', '自定义记忆模板注入', presetInstruction ? '含预设指令' : undefined, augmented);
    return JSON.stringify(body);
  }

  // ── 会话级注入去重 ──
  // 同一对话后续轮次：首轮已注入完整系统模板（含工具 schema）+预设，历史已携带，
  // 后续轮次仅补充本轮新选中的记忆条目（轻量包装），避免重复注入。
  const singleInjectionSessionId = getSingleInjectionSessionId(chatSessionId);
  syncConcreteSingleInjectionSession(chatSessionId, hasConcreteParentMessage);

  // 刷新页面后会话 id 在持久化集合但无内存记录→首轮已注入过，直接跳过。
  if (hookState._singleInjectionSessionIds.has(singleInjectionSessionId) && !hookState._sessionInjectionRecords.has(singleInjectionSessionId)) {
    // singleMemoryInjection=完全跳过模式（兼容旧配置）。
    if (shouldUseSingleMemoryInjection()) {
      body.prompt = originalPrompt;
      return JSON.stringify(body);
    }
  }

  const sessionRecord = getOrCreateSessionRecord(singleInjectionSessionId);
  const needSystemTemplate = !sessionRecord.systemTemplateInjected;
  const currentPresetHash = presetContentHash(effectivePreset);
  const needPreset = Boolean(presetInstruction) && (!sessionRecord.presetInjected || sessionRecord.presetContentHash !== currentPresetHash);

  // 仅指令预设路径（无记忆）。
  if (effectivePreset && !isPresetMemoryEnabled(effectivePreset)) {
    if (needPreset || needSystemTemplate) {
      const { augmented } = buildPromptForInstructionMode(originalPrompt, presetInstruction, false, [], thinkingEnabled);
      body.prompt = augmented;
      sessionRecord.presetInjected = true;
      sessionRecord.presetContentHash = currentPresetHash;
      markSingleInjectionSession(singleInjectionSessionId);
      emitInjectionEvent('preset', `预设注入：${effectivePreset.name}`, '仅指令', augmented);
    } else {
      body.prompt = originalPrompt;
      emitInjectionEvent('preset', `预设注入：${effectivePreset.name}`, '去重跳过', originalPrompt);
    }
    return JSON.stringify(body);
  }

  // 记忆 + 预设 + 系统模板路径（含 presetMemoryEnabled 与普通自动注入）。
  if (effectivePreset && isPresetMemoryEnabled(effectivePreset)) {
    targetMemories = resolvePresetMemories(effectivePreset);
  }

  // memory_get 读过的记忆：下一轮以（全文）补注入，避免 agent 只看到标题索引而重复调用。
  const readMemoryIds = hookState._memoryContentReadIds;
  if (readMemoryIds.size > 0) {
    const existingIds = new Set(targetMemories.map((memory) => memory.id));
    for (const memory of availableMemories) {
      if (memory.id != null && readMemoryIds.has(memory.id) && !existingIds.has(memory.id)) {
        targetMemories.push(memory);
      }
    }
  }
  const injectionMemories = readMemoryIds.size > 0
    ? targetMemories.map((memory) => (
        memory.id != null && readMemoryIds.has(memory.id) ? { ...memory, silentInject: true } : memory
      ))
    : targetMemories;
  const excludeMemoryIds = new Set(sessionRecord.injectedMemoryIds);
  for (const id of readMemoryIds) excludeMemoryIds.delete(id);

  const relatedIds = effectivePreset
    ? collectPresetRelatedMemoryIds(targetMemories, effectivePreset)
    : undefined;
  const hasRelatedMark = relatedIds ? Object.values(relatedIds).some((ids) => ids.length > 0) : false;

  let augmented: string;
  let usedMemoryIds: number[];

  if (needSystemTemplate) {
    // 首轮：完整系统模板（记忆+工具 schema+预设+格式提醒）。
    const result = buildAugmentedPrompt(originalPrompt, injectionMemories, {
      thinkingEnabled,
      tokenBudget: hookState.memoryTokenBudget,
      toolDescriptors: hookState.toolDescriptors,
      instructionBlock: needPreset ? presetInstruction : '',
      presetRelatedMemoryIds: relatedIds,
    });
    augmented = result.augmented;
    usedMemoryIds = result.usedMemoryIds;
    sessionRecord.systemTemplateInjected = true;
    if (needPreset) {
      sessionRecord.presetInjected = true;
      sessionRecord.presetContentHash = currentPresetHash;
    }
  } else {
    // 后续轮次：轻量补充——仅本轮新选中记忆 + 未注入的预设变更。
    const result = buildLightweightMemoryPrompt(originalPrompt, injectionMemories, {
      instructionBlock: needPreset ? presetInstruction : '',
      tokenBudget: hookState.memoryTokenBudget,
      excludeMemoryIds,
      toolDescriptors: hookState.toolDescriptors,
    });
    augmented = result.augmented;
    usedMemoryIds = result.usedMemoryIds;
    if (needPreset) {
      sessionRecord.presetInjected = true;
      sessionRecord.presetContentHash = currentPresetHash;
    }
  }

  body.prompt = augmented;
  for (const id of usedMemoryIds) if (id) sessionRecord.injectedMemoryIds.add(id);
  markSingleInjectionSession(singleInjectionSessionId);

  if (usedMemoryIds.length > 0) {
    hookState.onMemoriesUsed(usedMemoryIds);
    rememberContextMemoryIds(usedMemoryIds);
    // 非静默记忆只注入了索引，正文仍需 memory_get，不能标记为「已注入」。
    markMemoriesInjectedForContent(usedMemoryIds);
    // memory_get 读过的记忆本轮以全文补注入：标记已注入，避免下一轮再补。
    const readInjected = usedMemoryIds.filter((id) => readMemoryIds.has(id));
    if (readInjected.length > 0) {
      markMemoriesInjected(readInjected);
      for (const id of readInjected) hookState._memoryContentReadIds.delete(id);
    }
  }

  const detailParts = [
    usedMemoryIds.length > 0 ? `命中记忆 ${usedMemoryIds.length} 条` : null,
    needPreset ? '含预设指令' : null,
    hasRelatedMark ? '含预设关联标注' : null,
    needSystemTemplate ? `工具 ${hookState.toolDescriptors.length} 个${hasMcpTools() ? '（含 MCP）' : ''}` : '去重·轻量补充',
  ].filter(Boolean);
  debugLog('inject', {
    mode: needSystemTemplate ? 'full' : 'light',
    tools: hookState.toolDescriptors.length,
    memories: usedMemoryIds.length,
    promptChars: augmented.length,
  });
  emitInjectionEvent('memory', '记忆注入', detailParts.join('；') || undefined, augmented);
  return JSON.stringify(body);
}

function collectMemorySources(resolved: ResolvedSkills, preset: SystemPromptPreset | null): MemorySourceResult {
  const sources: Array<{ enabled: boolean; ids?: number[] }> = [];

  sources.push({ enabled: resolved.memoryEnabled, ids: resolved.memoryIds });

  if (preset) {
    sources.push({
      enabled: preset.memoryEnabled === true,
      ids: preset.memoryIds,
    });
  }

  let anyEnabled = false;
  let useAll = false;
  const specificIds = new Set<number>();

  for (const src of sources) {
    if (!src.enabled) continue;
    anyEnabled = true;
    if (!src.ids || src.ids.length === 0) {
      useAll = true;
    } else {
      for (const id of src.ids) specificIds.add(id);
    }
  }

  if (!anyEnabled) return { type: 'none' };
  if (useAll) return { type: 'all' };
  return { type: 'ids', ids: specificIds };
}

type MemorySourceResult =
  | { type: 'none' }
  | { type: 'all' }
  | { type: 'ids'; ids: Set<number> };

function resolveTargetMemories(source: MemorySourceResult): Memory[] {
  switch (source.type) {
    case 'none':
      return [];
    case 'all':
      return hookState.memories;
    case 'ids':
      return hookState.memories.filter((m) => m.id !== undefined && source.ids.has(m.id));
  }
}

interface ResolvedSkills {
  instructions: string;
  userInput: string;
  memoryEnabled: boolean;
  memoryIds?: number[];
}

/** 预设限定的记忆集合（preset.memoryIds 为空 = 全量记忆）。 */
function resolvePresetMemories(preset: SystemPromptPreset): Memory[] {
  const memoryIds = preset.memoryIds;
  if (!memoryIds || memoryIds.length === 0) return hookState.memories;
  return hookState.memories.filter((memory) => memory.id !== undefined && memoryIds.includes(memory.id));
}

function isPresetMemoryEnabled(preset: SystemPromptPreset): boolean {
  return preset.memoryEnabled === true;
}

function shouldUseMemoryPromptForSkill(resolved: ResolvedSkills, preset: SystemPromptPreset | null): boolean {
  return (preset ? isPresetMemoryEnabled(preset) : false) || resolved.memoryEnabled;
}

function buildPromptForInstructionMode(
  userInput: string,
  instructionBlock: string,
  useMemoryPrompt: boolean,
  targetMemories: Memory[],
  thinkingEnabled: boolean,
): { augmented: string; usedMemoryIds: number[] } {
  if (!useMemoryPrompt) {
    return buildInstructionOnlyPrompt(userInput, instructionBlock);
  }

  return buildAugmentedPrompt(userInput, targetMemories, {
    thinkingEnabled,
    tokenBudget: hookState.memoryTokenBudget,
    toolDescriptors: hookState.toolDescriptors,
    instructionBlock,
  });
}

function buildCustomMemoryModePrompt(userInput: string, ...instructionBlocks: string[]): { augmented: string; usedMemoryIds: number[] } {
  return buildCustomMemoryPrompt(
    userInput,
    joinInstructionBlocks(...instructionBlocks, hookState.customMemoryPrompt),
    { toolDescriptors: hookState.toolDescriptors },
  );
}

function joinInstructionBlocks(...blocks: string[]): string {
  return blocks.map((block) => block.trim()).filter(Boolean).join(INSTRUCTION_SEPARATOR);
}

function resolveSkills(skillName: string, args: string): ResolvedSkills | null {
  const primarySkill = hookState.skills.find((s) => s.name === skillName);
  if (!primarySkill) return null;

  const secondInvocation = parseSkillCommand('/' + args);
  if (secondInvocation) {
    const secondSkill = hookState.skills.find((s) => s.name === secondInvocation.skillName);
    if (secondSkill) {
      const combinedInstructions = primarySkill.instructions + INSTRUCTION_SEPARATOR + secondSkill.instructions;

      const anyMemoryEnabled = primarySkill.memoryEnabled || secondSkill.memoryEnabled;

      let mergedMemoryIds: number[] | undefined = undefined;
      if (anyMemoryEnabled) {
        const hasAllPrimary = primarySkill.memoryEnabled && (!primarySkill.memoryIds || primarySkill.memoryIds.length === 0);
        const hasAllSecond = secondSkill.memoryEnabled && (!secondSkill.memoryIds || secondSkill.memoryIds.length === 0);

        if (hasAllPrimary || hasAllSecond) {
          mergedMemoryIds = undefined;
        } else {
          const idSet = new Set<number>();
          if (primarySkill.memoryEnabled && primarySkill.memoryIds) {
            for (const id of primarySkill.memoryIds) idSet.add(id);
          }
          if (secondSkill.memoryEnabled && secondSkill.memoryIds) {
            for (const id of secondSkill.memoryIds) idSet.add(id);
          }
          mergedMemoryIds = idSet.size > 0 ? Array.from(idSet) : undefined;
        }
      }

      return {
        instructions: combinedInstructions,
        userInput: secondInvocation.args,
        memoryEnabled: anyMemoryEnabled,
        memoryIds: mergedMemoryIds,
      };
    }
  }

  return {
    instructions: primarySkill.instructions,
    userInput: args,
    memoryEnabled: primarySkill.memoryEnabled,
    memoryIds: primarySkill.memoryEnabled && primarySkill.memoryIds && primarySkill.memoryIds.length > 0
      ? primarySkill.memoryIds
      : undefined,
  };
}

// ─── XML Tool Stream Filter ──────────────────────────────────────
// Detects <memory_save>, <memory_update>, <memory_delete> XML blocks
// in SSE stream chunks and handles chunk-boundary truncation.

/** 一次工具调用的稳定指纹：同一次调用在流式重解析中只执行一次。 */
function toolCallFingerprint(call: ToolCall): string {
  const raw = (call.raw ?? '').trim();
  if (raw) return raw;
  try {
    return `${call.name}:${JSON.stringify(call.payload ?? {})}`;
  } catch {
    return `${call.name}:${String(call.payload)}`;
  }
}

/**
 * 通知新出现的工具调用。
 * 去重键 = 调用指纹 + 该指纹在本次解析结果中的序号：
 * - 流式重解析会重复解析同一调用 → 序号相同 → 不重复执行；
 * - 同一响应内合法出现两次相同调用（DSML 块内多条 invoke 共用同一个 raw）→ 序号不同 → 都会执行。
 * 只按下标或只按指纹都会出错。
 */
function notifyNewToolCalls(fullText: string, notified: Set<string>): void {
  const calls = extractToolCalls(fullText, { descriptors: hookState.toolDescriptors, recognizedTags: hookState.recognizedToolTags });
  const occurrences = new Map<string, number>();
  for (const call of calls) {
    const fingerprint = toolCallFingerprint(call);
    const ordinal = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, ordinal);
    const key = `${fingerprint}#${ordinal}`;
    if (notified.has(key)) continue;
    notified.add(key);
    debugLog('tool-call', { name: call.name, total: calls.length, textChars: fullText.length });
    hookState.onToolCall(call);
  }
}

function filterSSEChunkForDisplay(chunk: string, state: ToolStreamFilterState): string {
  state.sseRemainder += chunk;

  const splitIndex = state.sseRemainder.lastIndexOf('\n\n');
  if (splitIndex === -1) return '';

  const complete = state.sseRemainder.slice(0, splitIndex + 2);
  state.sseRemainder = state.sseRemainder.slice(splitIndex + 2);

  return complete
    .split('\n\n')
    .filter((block) => block.length > 0)
    .map((block) => filterSSEBlockForDisplay(block, state))
    .join('\n\n') + '\n\n';
}

function flushFilteredSSE(state: ToolStreamFilterState): string {
  if (!state.sseRemainder) return '';
  const flushed = filterSSEBlockForDisplay(state.sseRemainder, state);
  state.sseRemainder = '';
  return flushed ? flushed + '\n\n' : '';
}

function filterSSEBlockForDisplay(block: string, state: ToolStreamFilterState): string {
  const lines = block.split('\n');

  return lines.map((line) => {
    if (!line.startsWith('data:')) return line;

    const rawData = line.slice(5).trim();
    const parsed = parseSSEData(rawData);
    if (!parsed) return line;

    const filtered = filterParsedTextForDisplay(parsed, state);
    if (!filtered.changed) return line;

    return `data: ${JSON.stringify(filtered.value)}`;
  }).join('\n');
}

function filterParsedTextForDisplay(parsed: unknown, state: ToolStreamFilterState): { value: unknown; changed: boolean } {
  if (!parsed || typeof parsed !== 'object') return { value: parsed, changed: false };

  if (Array.isArray(parsed)) {
    let changed = false;
    const value = parsed.map((item) => {
      const filtered = filterParsedTextForDisplay(item, state);
      changed ||= filtered.changed;
      return filtered.value;
    });
    return { value, changed };
  }

  const record = parsed as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };

  if (typeof record.v === 'string') {
    const filtered = filterToolMarkupFromText(record.v, state);
    if (filtered.changed) {
      next.v = filtered.text;
      changed = true;
    }
  } else if (Array.isArray(record.v)) {
    const filteredItems = record.v.map((item) => {
      const filtered = filterParsedTextForDisplay(item, state);
      changed ||= filtered.changed;
      return filtered.value;
    });
    if (changed) next.v = filteredItems;
  }

  if (typeof record.content === 'string') {
    const filtered = filterToolMarkupFromText(record.content, state);
    if (filtered.changed) {
      next.content = filtered.text;
      changed = true;
    }
  }

  return { value: changed ? next : parsed, changed };
}

function filterToolMarkupFromText(text: string, state: ToolStreamFilterState): { text: string; changed: boolean } {
  const output = state.textFilter.push(text);
  return { text: output, changed: output !== text };
}

async function interceptFetchResponse(responsePromise: Promise<Response>): Promise<Response> {
  const response = await responsePromise;
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let fullText = '';
  const notifiedCalls = new Set<string>();
  let completed = false;
  /** 中断（用户点停止）或请求失败：保留工具卡片，但禁止自动续聊。 */
  let aborted = response.ok === false;
  let rawSSEAccumulator = '';
  const displayFilterState: ToolStreamFilterState = {
    sseRemainder: '',
    textFilter: createToolMarkupStreamFilter({
      descriptors: hookState.toolDescriptors,
      recognizedTags: hookState.recognizedToolTags,
    }),
  };

  const finalizeIfNeeded = () => {
    if (completed) return;
    completed = true;
    // 中断/失败时不再执行流里残留的工具调用：用户点「停止」后不应产生保存/删除副作用。
    if (!aborted) notifyNewToolCalls(fullText, notifiedCalls);
    hookState.onResponseComplete(fullText, { aborted });
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const flushed = flushFilteredSSE(displayFilterState);
            if (flushed) {
              controller.enqueue(encoder.encode(flushed));
            }
            // Flush any remaining raw SSE data not yet added to fullText
            if (rawSSEAccumulator.trim()) {
              const tailEvents = parseSSEChunk(rawSSEAccumulator);
              for (const event of tailEvents) {
                const parsed = parseSSEData(event.data);
                if (!parsed) continue;
                const text = extractTextFromParsed(parsed);
                if (text) fullText += text;
              }
              rawSSEAccumulator = '';
            }
            finalizeIfNeeded();
            controller.close();
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const filteredChunk = filterSSEChunkForDisplay(chunk, displayFilterState);
          if (filteredChunk) {
            controller.enqueue(encoder.encode(filteredChunk));
          }

          // Accumulate raw SSE data to handle events split across chunks
          rawSSEAccumulator += chunk;
          const splitIdx = rawSSEAccumulator.lastIndexOf('\n\n');
          if (splitIdx !== -1) {
            const completeData = rawSSEAccumulator.slice(0, splitIdx + 2);
            rawSSEAccumulator = rawSSEAccumulator.slice(splitIdx + 2);
            const events = parseSSEChunk(completeData);
            for (const event of events) {
              const parsed = parseSSEData(event.data);
              if (!parsed) continue;
              const text = extractTextFromParsed(parsed);
              if (text) {
                fullText += text;
                notifyNewToolCalls(fullText, notifiedCalls);
              }

              if (!completed && isStreamFinishedFromParsed(parsed)) {
                finalizeIfNeeded();
              }
            }
          }
        }
      } catch (error) {
        // 用户中断 / 网络错误：标记 aborted 后照常收尾（只落盘，不续聊）
        aborted = true;
        finalizeIfNeeded();
        try {
          controller.error(error);
        } catch {
          // 流已被页面侧关闭，无需再报错
        }
      }
    },
  });

  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function setupXHRResponseInterceptor(xhr: XMLHttpRequest) {
  let fullText = '';
  let lastLen = 0;
  const notifiedCalls = new Set<string>();
  let completed = false;
  /** 中断或 HTTP 失败：禁止自动续聊。 */
  let aborted = false;

  const finalizeIfNeeded = () => {
    if (completed) return;
    completed = true;
    const failed = aborted || xhr.status >= 400;
    // 中断/失败时不再执行流里残留的工具调用，避免「点了停止仍然写记忆」。
    if (!failed) notifyNewToolCalls(fullText, notifiedCalls);
    hookState.onResponseComplete(fullText, { aborted: failed });
  };

  xhr.addEventListener('abort', () => {
    aborted = true;
  });

  xhr.addEventListener('readystatechange', function () {
    if (xhr.readyState === 3 || xhr.readyState === 4) {
      const raw = xhr.responseText;
      const newData = raw.slice(lastLen);
      lastLen = raw.length;
      if (newData) {
        const events = parseSSEChunk(newData);
        for (const event of events) {
          const parsed = parseSSEData(event.data);
          if (!parsed) continue;
          const text = extractTextFromParsed(parsed);
          if (text) {
            fullText += text;
            notifyNewToolCalls(fullText, notifiedCalls);
          }
        }
      }
    }
    if (xhr.readyState === 4) finalizeIfNeeded();
  });
}

// ─── History API Intercept ─────────────────────────────────────────
// Intercept /api/v0/chat/history_messages to strip tool calls from
// stored message content, collecting restore records.

function hookHistoryFetch() {
  const savedFetch = window.fetch;

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (!url.includes(HISTORY_PATH)) {
      return savedFetch.call(this, input, init);
    }

    return savedFetch.call(this, input, init).then(async (response) => {
      const clone = response.clone();
      try {
        const json = await clone.json();
        const historySessionId = getHistorySessionIdFromUrl(url);
        storedHistoryRaw = { json, sessionId: historySessionId };
        const { cleaned, records } = stripToolCallsFromHistoryInternal(json, historySessionId);
        if (records.length > 0) {
          hookState.onToolCallsRestored(records);
        }
        // 重建响应时必须剔除编码/长度头：body 已是明文 JSON，沿用原头会让页面按 gzip 解析而报错。
        const headers = new Headers(response.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        return new Response(JSON.stringify(cleaned), {
          headers,
          status: response.status,
          statusText: response.statusText,
        });
      } catch {
        return response;
      }
    });
  };
}

function hookHistoryXHR() {
  const xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    xhrUrls.set(this, typeof url === 'string' ? url : url.href);
    return origOpen.apply(this, [method, url as string, ...rest] as Parameters<typeof origOpen>);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = xhrUrls.get(this);
    if (url && url.includes(HISTORY_PATH)) {
      const origOnreadystatechange = this.onreadystatechange;
      this.onreadystatechange = function (this: XMLHttpRequest, ev: Event) {
        if (this.readyState === 4) {
          try {
            const json = JSON.parse(this.responseText);
            const historySessionId = getHistorySessionIdFromUrl(url);
            storedHistoryRaw = { json, sessionId: historySessionId };
            const { cleaned, records } = stripToolCallsFromHistoryInternal(json, historySessionId);
            if (records.length > 0) {
              hookState.onToolCallsRestored(records);
            }
            Object.defineProperty(this, 'responseText', {
              value: JSON.stringify(cleaned),
              writable: false,
            });
            Object.defineProperty(this, 'response', {
              value: JSON.stringify(cleaned),
              writable: false,
            });
          } catch {
            // ignore parse errors
          }
        }
        if (typeof origOnreadystatechange === 'function') {
          origOnreadystatechange.call(this, ev);
        }
      };
    }
    return origSend.call(this, body);
  };
}

function stripToolCallsFromHistoryInternal(json: any, fallbackSessionId: string | null = null): { cleaned: any; records: ToolCallRestoreRecord[] } {
  const records: ToolCallRestoreRecord[] = [];
  const cleaned = { ...json };
  const chatSessionId = getHistorySessionId(cleaned) ?? fallbackSessionId;

  if (cleaned.chat_messages && Array.isArray(cleaned.chat_messages)) {
    let assistantIndex = -1;
    cleaned.chat_messages = cleaned.chat_messages.map((msg: any) => {
      if (!msg || msg.role !== 'assistant') return msg;
      assistantIndex += 1;

      const toolCallSource = getHistoryToolCallSource(msg);
      const toolCalls = extractToolCalls(toolCallSource, { descriptors: hookState.toolDescriptors, recognizedTags: hookState.recognizedToolTags });
      if (toolCalls.length === 0) return msg;

      const cleanContent = stripToolCalls(msg.content || '', { descriptors: hookState.toolDescriptors, recognizedTags: hookState.recognizedToolTags });
      const cleanToolCallSource = stripToolCalls(toolCallSource, { descriptors: hookState.toolDescriptors, recognizedTags: hookState.recognizedToolTags });
      const cleanFragments = msg.fragments
        ? msg.fragments.map((f: any) => ({
            ...f,
        content: stripToolCalls(f.content || '', { descriptors: hookState.toolDescriptors, recognizedTags: hookState.recognizedToolTags }),
          }))
        : msg.fragments;

      records.push({
        id: msg.id || crypto.randomUUID(),
        calls: toolCalls,
        executions: [],
        content: toolCallSource,
        source: 'history',
        url: '',
        timestamp: Date.now(),
        metadata: { cleanContent: cleanContent || cleanToolCallSource, assistantIndex, ...(chatSessionId ? { chatSessionId } : {}) },
      });

      return {
        ...msg,
        content: cleanContent,
        fragments: cleanFragments,
      };
    });
  }

  return { cleaned, records };
}

function getHistorySessionId(json: any): string | null {
  const candidates = [
    json?.chat_session?.id,
    json?.chat_session_id,
    json?.biz_data?.chat_session?.id,
    json?.biz_data?.chat_session_id,
    json?.data?.chat_session?.id,
    json?.data?.chat_session_id,
    json?.chat_messages?.[0]?.chat_session_id,
    json?.chat_messages?.[0]?.session_id,
  ];
  return candidates.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

function getHistorySessionIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.searchParams.get('chat_session_id') ?? parsed.searchParams.get('chat_session_id[]');
  } catch {
    return null;
  }
}

function getHistoryToolCallSource(msg: any): string {
  const parts: string[] = [];
  if (typeof msg.content === 'string') parts.push(msg.content);
  if (Array.isArray(msg.fragments)) {
    for (const fragment of msg.fragments) {
      if (typeof fragment?.content === 'string') parts.push(fragment.content);
    }
  }
  return parts.join('\n');
}

// ─── IndexedDB Intercept ───────────────────────────────────────────

function hookIndexedDB() {
  const origGet = IDBObjectStore.prototype.get;
  const origGetAll = IDBObjectStore.prototype.getAll;

  IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
    const result = origGet.call(this, key as any);
    const storeName = (this as any).name;

    if (storeName === 'history-message') {
      const origResult = result;
      return new Proxy(origResult, {
        get(target, prop) {
          if (prop === 'result') {
            const value = (target as any).result;
            if (value && typeof value === 'object') {
              return cleanHistoryResult(value);
            }
            return value;
          }
          return getNativeRequestProperty(target, prop);
        },
        set(target, prop, value) {
          return Reflect.set(target, prop, value, target);
        },
      });
    }

    return result;
  };

  IDBObjectStore.prototype.getAll = function (query?: IDBValidKey | IDBKeyRange | null, count?: number) {
    const result = origGetAll.call(this, query as any, count);
    const storeName = (this as any).name;

    if (storeName === 'history-message') {
      return new Proxy(result, {
        get(target, prop) {
          if (prop === 'result') {
            const value = (target as any).result;
            if (Array.isArray(value)) {
              return value.map((item: any) => cleanHistoryResult(item));
            }
            return value;
          }
          return getNativeRequestProperty(target, prop);
        },
        set(target, prop, value) {
          return Reflect.set(target, prop, value, target);
        },
      });
    }

    return result;
  };
}

function getNativeRequestProperty(target: IDBRequest, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop, target);
  return typeof value === 'function' ? value.bind(target) : value;
}

function cleanHistoryResult(item: any): any {
  if (!item || typeof item !== 'object') return item;
  if (item.role !== 'assistant') return item;

  const content = item.content || '';
  if (!hasXmlToolMarker(content, createToolInvocationCatalog(hookState.toolDescriptors, hookState.recognizedToolTags)) && !content.includes('<dpp')) return item;

  const cleanContent = content
    .replace(createDynamicToolRegex(), '')
    .replace(/<｜DSML｜tool_calls>[\s\S]*?<\/｜DSML｜tool_calls>/g, '')
    .trim();

  return {
    ...item,
    content: cleanContent,
  };
}

function createDynamicToolRegex(): RegExp {
  const catalog = createToolInvocationCatalog(hookState.toolDescriptors, hookState.recognizedToolTags);
  if (catalog.invocationNames.length === 0) return /$a/g;
  const names = catalog.invocationNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`<(${names})>\\s*[\\s\\S]*?\\s*<\\/\\1>`, 'g');
}

// ─── Memory Command Parsing ────────────────────────────────────────

interface MemoryInvocation {
  memories: Memory[];
  args: string;
  rawInput: string;
}

const MAX_MEMORY_COMMAND_ENTRIES = 20;

/** 匹配输入开头的一个 `#名称` / `#id`，返回记忆与剩余文本。导出给 `#` 弹窗复用同一解析规则。 */
export function matchLeadingMemory(input: string, sortedMemories: Memory[]): { memory: Memory; rest: string } | null {
  const inputLower = input.toLowerCase();

  for (const memory of sortedMemories) {
    const prefixes = [`#${memory.name.toLowerCase()}`];
    if (memory.id != null) prefixes.push(`#${memory.id}`);

    for (const prefix of prefixes) {
      if (inputLower === prefix) return { memory, rest: '' };
      if (inputLower.startsWith(prefix + ' ') || inputLower.startsWith(prefix + '\n')) {
        return { memory, rest: input.slice(prefix.length + 1) };
      }
    }
  }

  return null;
}

/**
 * `#记忆名` 显式手动注入。支持一条消息注入多条：`#记忆A #记忆B 正文`
 * （弹窗多选后写入即为该形态）。
 */
function parseMemoryCommand(input: string, memories: Memory[]): MemoryInvocation | null {
  if (!input.startsWith('#')) return null;

  const sortedMemories = [...memories].sort((a, b) => b.name.length - a.name.length);
  const matched: Memory[] = [];
  const matchedKeys = new Set<string>();
  let rest = input;

  for (let guard = 0; guard < MAX_MEMORY_COMMAND_ENTRIES; guard += 1) {
    const parsed = matchLeadingMemory(rest, sortedMemories);
    if (!parsed) break;

    const key = parsed.memory.id != null ? `id:${parsed.memory.id}` : `name:${parsed.memory.name}`;
    if (!matchedKeys.has(key)) {
      matchedKeys.add(key);
      matched.push(parsed.memory);
    }
    rest = parsed.rest;
    if (!rest.startsWith('#')) break;
  }

  if (matched.length === 0) return null;
  return { memories: matched, args: rest, rawInput: input };
}

function wrapMemoryInput(memoryName: string, memoryContent: string, userInput: string): string {
  const header = fillTemplate(resolveTemplate('MEMORY_BACKGROUND_TEMPLATE', MEMORY_BACKGROUND_TEMPLATE), {
    memoryName,
    memoryContent,
  });
  if (!userInput) return header;
  return `${header}${INSTRUCTION_SEPARATOR}${renderUserInputBlock(userInput)}`;
}
