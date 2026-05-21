import { DEEPSEEK_API_URL, PRESET_REINJECTION_INTERVAL } from '../constants';
import type { Memory, ModelType, SystemPromptPreset, ToolCall, Skill } from '../types';
import { buildAugmentedPrompt } from '../memory/injector';
import { parseSkillCommand } from '../skill/parser';
import { extractTextFromParsed, isStreamFinishedFromParsed, parseSSEChunk, parseSSEData } from './sse-parser';
import { extractToolCalls } from './tool-parser';

const API_PATH = new URL(DEEPSEEK_API_URL).pathname;

interface HookState {
  memories: Memory[];
  skills: Skill[];
  activePreset: SystemPromptPreset | null;
  modelType: ModelType;
  messageCount: number;
  _lastPresetId: string | null;
  onToolCall: (call: ToolCall) => void;
  onResponseComplete: (fullText: string) => void;
  onMemoriesUsed: (ids: number[]) => void;
}

let hookState: HookState = {
  memories: [],
  skills: [],
  activePreset: null,
  modelType: null,
  messageCount: 0,
  _lastPresetId: null,
  onToolCall: () => {},
  onResponseComplete: () => {},
  onMemoriesUsed: () => {},
};

export function updateHookState(partial: Partial<HookState>) {
  hookState = { ...hookState, ...partial };
}

export function installFetchHook() {
  hookFetch();
  hookXHR();
}

function hookFetch() {
  const originalFetch = window.fetch;

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (!isChatCompletionURL(url) || !init?.body) {
      return originalFetch.call(this, input, init);
    }

    const modified = modifyRequestBody(init.body as string);
    if (!modified) return originalFetch.call(this, input, init);

    init = { ...init, body: modified };
    return interceptFetchResponse(originalFetch.call(this, input, init));
  };
}

function hookXHR() {
  const xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    xhrUrls.set(this, typeof url === 'string' ? url : url.href);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
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
  const isFirstMessage = body.parent_message_id === null || body.parent_message_id === undefined;

  if (isFirstMessage) {
    hookState.messageCount = 0;
    hookState._lastPresetId = hookState.activePreset?.id ?? null;
  }
  hookState.messageCount++;

  // Detect if the preset changed mid-conversation (e.g. via @ trigger)
  const currentPresetId = hookState.activePreset?.id ?? null;
  const presetJustChanged = currentPresetId !== hookState._lastPresetId;
  if (presetJustChanged) {
    hookState._lastPresetId = currentPresetId;
  }

  const shouldInjectPreset =
    hookState.activePreset &&
    (isFirstMessage || presetJustChanged || hookState.messageCount % PRESET_REINJECTION_INTERVAL === 0);

  const presetPrefix = shouldInjectPreset
    ? hookState.activePreset!.content + '\n\n---\n\n'
    : '';

  if (hookState.modelType) {
    body.model_type = hookState.modelType;
  }

  const memInvocation = parseMemoryCommand(originalPrompt, hookState.memories);
  if (memInvocation) {
    const { memory, args } = memInvocation;
    const prompt = wrapMemoryInput(memory.name, memory.content, args);

    body.prompt = presetPrefix + prompt;
    if (memory.id != null) {
      hookState.onMemoriesUsed([memory.id]);
    }
    return JSON.stringify(body);
  }

  const invocation = parseSkillCommand(originalPrompt);
  if (invocation) {
    const resolved = resolveSkills(invocation.skillName, invocation.args);
    if (resolved) {
      let prompt = resolved.combinedPrompt;

      // Collect memory sources: skill config + active preset config
      const memorySources = collectMemorySources(resolved);
      const targetMemories = resolveTargetMemories(memorySources);

      if (targetMemories.length > 0) {
        const { augmented } = buildAugmentedPrompt(prompt, targetMemories, { thinkingEnabled });
        prompt = augmented;
      }

      body.prompt = presetPrefix + prompt;
      return JSON.stringify(body);
    }
  }

  // Determine which memories to inject based on preset configuration
  let targetMemories = hookState.memories;
  let identityOnly = false;

  if (hookState.activePreset) {
    if (hookState.activePreset.memoryEnabled === true) {
      // Explicitly enabled: use specified memoryIds if provided, otherwise all
      if (hookState.activePreset.memoryIds && hookState.activePreset.memoryIds.length > 0) {
        targetMemories = hookState.memories.filter(
          (m) => m.id !== undefined && hookState.activePreset!.memoryIds!.includes(m.id)
        );
      }
    } else {
      // Not explicitly enabled (false or undefined): no memories injected
      targetMemories = [];
    }
  }

  const { augmented, usedMemoryIds } = buildAugmentedPrompt(originalPrompt, targetMemories, {
    thinkingEnabled,
    identityOnly,
  });
  body.prompt = presetPrefix + augmented;

  if (usedMemoryIds.length > 0) {
    hookState.onMemoriesUsed(usedMemoryIds);
  }

  return JSON.stringify(body);
}

/**
 * Collect memory configuration from skill resolution and active preset.
 * Returns: { useAll: true } if any source enables all memories,
 *          or { ids: Set<number> } for specific IDs,
 *          or { none: true } if no source enables memories.
 */
function collectMemorySources(resolved: ResolvedSkills): MemorySourceResult {
  const sources: Array<{ enabled: boolean; ids?: number[] }> = [];

  // Skill config
  sources.push({ enabled: resolved.memoryEnabled, ids: resolved.memoryIds });

  // Active preset config
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
      // Enabled but no specific IDs → use all memories
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

/**
 * Resolve target memories from collected sources, with deduplication.
 */
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
  combinedPrompt: string;
  memoryEnabled: boolean;
  memoryIds?: number[];
}

function wrapUserInput(instructions: string, userInput: string): string {
  return `${instructions}\n\n---\n\n以下是用户本次的输入，请根据上述指令处理：\n\n${userInput}`;
}

function resolveSkills(skillName: string, args: string): ResolvedSkills | null {
  const primarySkill = hookState.skills.find((s) => s.name === skillName);
  if (!primarySkill) return null;

  const secondInvocation = parseSkillCommand('/' + args);
  if (secondInvocation) {
    const secondSkill = hookState.skills.find((s) => s.name === secondInvocation.skillName);
    if (secondSkill) {
      const userArgs = secondInvocation.args;
      const combinedInstructions = primarySkill.instructions + '\n\n---\n\n' + secondSkill.instructions;

      const anyMemoryEnabled = primarySkill.memoryEnabled || secondSkill.memoryEnabled;

      // Merge memory IDs; if either skill is enabled with no specific IDs → use all (return undefined)
      let mergedMemoryIds: number[] | undefined = undefined;
      if (anyMemoryEnabled) {
        const hasAllPrimary = primarySkill.memoryEnabled && (!primarySkill.memoryIds || primarySkill.memoryIds.length === 0);
        const hasAllSecond = secondSkill.memoryEnabled && (!secondSkill.memoryIds || secondSkill.memoryIds.length === 0);

        if (hasAllPrimary || hasAllSecond) {
          // At least one wants all memories → use all
          mergedMemoryIds = undefined;
        } else {
          // Both specify specific IDs → merge & deduplicate
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
        combinedPrompt: userArgs
          ? wrapUserInput(combinedInstructions, userArgs)
          : combinedInstructions,
        memoryEnabled: anyMemoryEnabled,
        memoryIds: mergedMemoryIds,
      };
    }
  }

  return {
    combinedPrompt: args
      ? wrapUserInput(primarySkill.instructions, args)
      : primarySkill.instructions,
    memoryEnabled: primarySkill.memoryEnabled,
    // memoryIds: undefined means "all" when memoryEnabled is true
    memoryIds: primarySkill.memoryEnabled && primarySkill.memoryIds && primarySkill.memoryIds.length > 0
      ? primarySkill.memoryIds
      : undefined,
  };
}

function notifyNewToolCalls(fullText: string, alreadyNotified: number): number {
  const calls = extractToolCalls(fullText);
  for (let i = alreadyNotified; i < calls.length; i++) {
    hookState.onToolCall(calls[i]);
  }
  return calls.length;
}

async function interceptFetchResponse(responsePromise: Promise<Response>): Promise<Response> {
  const response = await responsePromise;
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let notifiedCount = 0;
  let completed = false;

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
          finalizeIfNeeded();
          controller.close();
          break;
        }

        controller.enqueue(value);

        const chunk = decoder.decode(value, { stream: true });
        const events = parseSSEChunk(chunk);
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
    // Check by name
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

    // Check by ID
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
