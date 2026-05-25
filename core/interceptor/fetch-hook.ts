import { DEEPSEEK_API_URL } from '../constants';
import { DEFAULT_RECOGNIZED_TOOL_TAGS, createToolInvocationCatalog, getToolCloseTag, getToolOpenTag, hasXmlToolMarker } from '../tool';
import type { Memory, ModelType, SystemPromptPreset, ToolCall, ToolCardResult, ToolCallRestoreRecord, Skill, ToolDescriptor } from '../types';
import { buildAugmentedPrompt } from '../memory/injector';
import { parseSkillCommand } from '../skill/parser';
import { extractTextFromParsed, isStreamFinishedFromParsed, parseSSEChunk, parseSSEData } from './sse-parser';
import { extractToolCalls, stripToolCalls } from './tool-parser';

const API_PATH = new URL(DEEPSEEK_API_URL).pathname;
const HISTORY_PATH = '/api/v0/chat/history_messages';

interface HookState {
  memories: Memory[];
  skills: Skill[];
  activePreset: SystemPromptPreset | null;
  modelType: ModelType;
  toolDescriptors: ToolDescriptor[];
  recognizedToolTags: string[];
  memoryTokenBudget: number;
  _lastChatSessionId: string | null;
  onToolCall: (call: ToolCall) => void;
  onResponseComplete: (fullText: string) => void;
  onMemoriesUsed: (ids: number[]) => void;
  onToolCallExecuted: (call: ToolCall) => Promise<ToolCardResult>;
  onToolCallsRestored: (records: ToolCallRestoreRecord[]) => void;
  onSkillUsed: (name: string) => void;
}

let hookState: HookState = {
  memories: [],
  skills: [],
  activePreset: null,
  modelType: null,
  toolDescriptors: [],
  recognizedToolTags: [...DEFAULT_RECOGNIZED_TOOL_TAGS],
  memoryTokenBudget: 3000,
  _lastChatSessionId: null,
  onToolCall: () => {},
  onResponseComplete: () => {},
  onMemoriesUsed: () => {},
  onToolCallExecuted: async () => ({ ok: true, summary: '已识别' }),
  onToolCallsRestored: () => {},
  onSkillUsed: () => {},
};

let originalFetch: typeof window.fetch | null = null;

/** Cache of the raw history API response, re-processed when MCP tool descriptors arrive late */
let storedHistoryRaw: { json: unknown; sessionId: string | null } | null = null;

interface ToolStreamFilterState {
  insideToolBlock: boolean;
  sseRemainder: string;
}

export function updateHookState(partial: Partial<HookState>) {
  hookState = { ...hookState, ...partial };
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

export function installFetchHook() {
  originalFetch = window.fetch;
  hookFetch();
  hookXHR();
  hookHistoryFetch();
  hookHistoryXHR();
  hookIndexedDB();
}

function hookFetch() {
  const savedFetch = window.fetch;

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (!isChatCompletionURL(url) || !init?.body) {
      return savedFetch.call(this, input, init);
    }

    const modified = modifyRequestBody(init.body as string);
    if (!modified) return savedFetch.call(this, input, init);

    init = { ...init, body: modified };
    return interceptFetchResponse(savedFetch.call(this, input, init));
  };
}

function hookXHR() {
  const xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    xhrUrls.set(this, typeof url === 'string' ? url : url.href);
    return origOpen.apply(this, [method, url as string, ...rest] as Parameters<typeof origOpen>);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = xhrUrls.get(this);
    if (url && isChatCompletionURL(url) && typeof body === 'string') {
      const modified = modifyRequestBody(body);
      if (modified) {
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

function modifyRequestBody(bodyStr: string): string | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    return null;
  }

  const originalPrompt = (body.prompt as string) || '';
  if (!originalPrompt) return null;

  const thinkingEnabled = body.thinking_enabled === true;
  const chatSessionId = typeof body.chat_session_id === 'string' ? body.chat_session_id : null;
  const chatSessionChanged = chatSessionId !== null && chatSessionId !== hookState._lastChatSessionId;
  const isFirstMessage =
    body.parent_message_id === null ||
    body.parent_message_id === undefined ||
    chatSessionChanged;

  if (chatSessionId !== null) {
    hookState._lastChatSessionId = chatSessionId;
  }

  const shouldInjectPreset = Boolean(hookState.activePreset);

  const presetInstruction = shouldInjectPreset
    ? hookState.activePreset!.content
    : '';

  if (hookState.modelType) {
    body.model_type = hookState.modelType;
  }

  const memInvocation = parseMemoryCommand(originalPrompt, hookState.memories);
  if (memInvocation) {
    const { memory, args } = memInvocation;
    const memoryInstruction = wrapMemoryInput(memory.name, memory.content, '');
    const { augmented } = buildAugmentedPrompt(args, [], {
      thinkingEnabled,
      tokenBudget: hookState.memoryTokenBudget,
      toolDescriptors: hookState.toolDescriptors,
      instructionBlock: joinInstructionBlocks(presetInstruction, memoryInstruction),
    });

    body.prompt = augmented;
    if (memory.id != null) {
      hookState.onMemoriesUsed([memory.id]);
    }
    return JSON.stringify(body);
  }

  const invocation = parseSkillCommand(originalPrompt);
  if (invocation) {
    const resolved = resolveSkills(invocation.skillName, invocation.args);
    if (resolved) {
      const memorySources = collectMemorySources(resolved);
      const targetMemories = resolveTargetMemories(memorySources);
      const { augmented, usedMemoryIds } = buildAugmentedPrompt(resolved.userInput, targetMemories, {
        thinkingEnabled,
        tokenBudget: hookState.memoryTokenBudget,
        toolDescriptors: hookState.toolDescriptors,
        instructionBlock: joinInstructionBlocks(presetInstruction, resolved.instructions),
      });

      body.prompt = augmented;
      if (usedMemoryIds.length > 0) {
        hookState.onMemoriesUsed(usedMemoryIds);
      }
      hookState.onSkillUsed(invocation.skillName);
      return JSON.stringify(body);
    }
  }

  let targetMemories = hookState.memories;
  let identityOnly = false;

  if (hookState.activePreset) {
    if (hookState.activePreset.memoryEnabled === true) {
      if (hookState.activePreset.memoryIds && hookState.activePreset.memoryIds.length > 0) {
        targetMemories = hookState.memories.filter(
          (m) => m.id !== undefined && hookState.activePreset!.memoryIds!.includes(m.id)
        );
      }
    } else {
      targetMemories = [];
    }
  }

  const { augmented, usedMemoryIds } = buildAugmentedPrompt(originalPrompt, targetMemories, {
    thinkingEnabled,
    identityOnly,
    tokenBudget: hookState.memoryTokenBudget,
    toolDescriptors: hookState.toolDescriptors,
    instructionBlock: presetInstruction,
  });
  body.prompt = augmented;

  if (usedMemoryIds.length > 0) {
    hookState.onMemoriesUsed(usedMemoryIds);
  }

  return JSON.stringify(body);
}

function collectMemorySources(resolved: ResolvedSkills): MemorySourceResult {
  const sources: Array<{ enabled: boolean; ids?: number[] }> = [];

  sources.push({ enabled: resolved.memoryEnabled, ids: resolved.memoryIds });

  if (hookState.activePreset) {
    sources.push({
      enabled: hookState.activePreset.memoryEnabled === true,
      ids: hookState.activePreset.memoryIds,
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

function joinInstructionBlocks(...blocks: string[]): string {
  return blocks.map((block) => block.trim()).filter(Boolean).join('\n\n---\n\n');
}

function resolveSkills(skillName: string, args: string): ResolvedSkills | null {
  const primarySkill = hookState.skills.find((s) => s.name === skillName);
  if (!primarySkill) return null;

  const secondInvocation = parseSkillCommand('/' + args);
  if (secondInvocation) {
    const secondSkill = hookState.skills.find((s) => s.name === secondInvocation.skillName);
    if (secondSkill) {
      const combinedInstructions = primarySkill.instructions + '\n\n---\n\n' + secondSkill.instructions;

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

function notifyNewToolCalls(fullText: string, alreadyNotified: number): number {
  const calls = extractToolCalls(fullText, { descriptors: hookState.toolDescriptors, recognizedTags: hookState.recognizedToolTags });
  for (let i = alreadyNotified; i < calls.length; i++) {
    hookState.onToolCall(calls[i]);
  }
  return calls.length;
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
  let output = '';
  let cursor = 0;
  let changed = false;

  while (cursor < text.length) {
    if (state.insideToolBlock) {
      const endIndex = findNextToolCloseIndex(text, cursor);
      if (endIndex === -1) {
        changed = true;
        break;
      }
      cursor = endIndex;
      state.insideToolBlock = false;
      changed = true;
      continue;
    }

    const openMatch = findNextToolOpen(text, cursor);
    if (!openMatch) {
      output += text.slice(cursor);
      break;
    }

    output += text.slice(cursor, openMatch.index);
    cursor = openMatch.index + openMatch.tag.length;
    state.insideToolBlock = true;
    changed = true;
  }

  return { text: output, changed };
}

function findNextToolOpen(text: string, cursor: number): { index: number; tag: string } | null {
  const catalog = createToolInvocationCatalog(hookState.toolDescriptors, hookState.recognizedToolTags);
  let best: { index: number; tag: string } | null = null;
  for (const name of catalog.invocationNames) {
    const tag = getToolOpenTag(name);
    const index = text.indexOf(tag, cursor);
    if (index !== -1 && (!best || index < best.index)) best = { index, tag };
  }
  return best;
}

function findNextToolCloseIndex(text: string, cursor: number): number {
  const catalog = createToolInvocationCatalog(hookState.toolDescriptors, hookState.recognizedToolTags);
  let best = -1;
  let bestLength = 0;
  for (const name of catalog.invocationNames) {
    const tag = getToolCloseTag(name);
    const index = text.indexOf(tag, cursor);
    if (index !== -1 && (best === -1 || index < best)) {
      best = index;
      bestLength = tag.length;
    }
  }
  return best === -1 ? -1 : best + bestLength;
}

async function interceptFetchResponse(responsePromise: Promise<Response>): Promise<Response> {
  const response = await responsePromise;
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let fullText = '';
  let notifiedCount = 0;
  let completed = false;
  let rawSSEAccumulator = '';
  const displayFilterState: ToolStreamFilterState = { insideToolBlock: false, sseRemainder: '' };

  const finalizeIfNeeded = () => {
    if (completed) return;
    completed = true;
    notifiedCount = notifyNewToolCalls(fullText, notifiedCount);
    hookState.onResponseComplete(fullText);
  };

  const stream = new ReadableStream({
    async start(controller) {
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
              notifiedCount = notifyNewToolCalls(fullText, notifiedCount);
            }

            if (!completed && isStreamFinishedFromParsed(parsed)) {
              finalizeIfNeeded();
            }
          }
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
  let notifiedCount = 0;
  let completed = false;

  const finalizeIfNeeded = () => {
    if (completed) return;
    completed = true;
    notifiedCount = notifyNewToolCalls(fullText, notifiedCount);
    hookState.onResponseComplete(fullText);
  };

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
            notifiedCount = notifyNewToolCalls(fullText, notifiedCount);
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
        return new Response(JSON.stringify(cleaned), {
          headers: response.headers,
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
  memory: Memory;
  args: string;
  rawInput: string;
}

function parseMemoryCommand(input: string, memories: Memory[]): MemoryInvocation | null {
  if (!input.startsWith('#')) return null;

  const inputLower = input.toLowerCase();
  const sortedMemories = [...memories].sort((a, b) => b.name.length - a.name.length);

  for (const m of sortedMemories) {
    const prefixName = `#${m.name.toLowerCase()}`;
    if (inputLower === prefixName) {
      return { memory: m, args: '', rawInput: input };
    }
    if (inputLower.startsWith(prefixName + ' ')) {
      return { memory: m, args: input.slice(prefixName.length + 1), rawInput: input };
    }
    if (inputLower.startsWith(prefixName + '\n')) {
      return { memory: m, args: input.slice(prefixName.length + 1), rawInput: input };
    }

    if (m.id != null) {
      const prefixId = `#${m.id}`;
      if (inputLower === prefixId) {
        return { memory: m, args: '', rawInput: input };
      }
      if (inputLower.startsWith(prefixId + ' ')) {
        return { memory: m, args: input.slice(prefixId.length + 1), rawInput: input };
      }
      if (inputLower.startsWith(prefixId + '\n')) {
        return { memory: m, args: input.slice(prefixId.length + 1), rawInput: input };
      }
    }
  }

  return null;
}

function wrapMemoryInput(memoryName: string, memoryContent: string, userInput: string): string {
  const header = `背景信息（记忆：${memoryName}）：\n${memoryContent}`;
  if (!userInput) return header;
  return `${header}\n\n---\n\n以下是用户本次的输入：\n\n${userInput}`;
}
