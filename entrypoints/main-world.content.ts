import { installFetchHook, updateHookState, reprocessStoredHistory, bindPendingSingleInjectionSession, recordMemoryToolRead } from '../core/interceptor/fetch-hook';
import type { MemoryConfig } from '../core/memory/config';
import type { TemplateOverrides } from '../core/templates/overrides';
import { initSkillPopup } from '../core/ui/skill-popup';
import { initMemoryPopup } from '../core/ui/memory-popup';
import { initPresetPopup } from '../core/ui/preset-popup';
// @Archived: [2026-11-20] 上下文注入记录弹窗已下线，原实现见 core/ui/archive/context-capsule.ts
import { DEFAULT_RECOGNIZED_TOOL_TAGS } from '../core/tool';
import type { Memory, ModelType, Skill, SystemPromptPreset, ToolCall, ToolCardResult, ToolCallRestoreRecord, ToolDescriptor } from '../core/types';

let latestMemories: Memory[] = [];
let latestMemoryConfig: MemoryConfig | null = null;
let latestUserPrompt = '';

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // fetch/XHR 必须在 MAIN world 拦截，content world 只负责 UI 与扩展 API 桥接。
    installFetchHook();
    watchRouteChanges();

    // @Archived: [2026-11-20] 上下文胶囊初始化（initContextCapsule / 排除回调）已随功能下线移除。
    updateHookState({
      onTurnStart() {
        window.postMessage({ source: 'WebTool-DeepSeek-main', type: 'TURN_START' });
      },
      onUserPrompt(prompt: string) {
        latestUserPrompt = prompt;
      },
      onToolCall(call: ToolCall) {
        window.postMessage({
          source: 'WebTool-DeepSeek-main',
          type: 'TOOL_CALL',
          data: call,
        });
      },
      async onToolCallExecuted(call: ToolCall): Promise<ToolCardResult> {
        return new Promise((resolve) => {
          const handler = (event: MessageEvent) => {
            if (
              event.data?.source !== 'WebTool-DeepSeek-content' ||
              event.data?.type !== 'TOOL_CALL_RESULT' ||
              event.data?.callName !== call.name
            ) return;
            window.removeEventListener('message', handler);
            resolve(event.data.data as ToolCardResult);
          };
          window.addEventListener('message', handler);

          window.postMessage({
            source: 'WebTool-DeepSeek-main',
            type: 'EXECUTE_TOOL_CALL',
            data: call,
          });

          // Timeout fallback after 10s
          setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve({ ok: true, summary: '已执行' });
          }, 10000);
        });
      },
      onToolCallsRestored(records: ToolCallRestoreRecord[]) {
        window.postMessage({
          source: 'WebTool-DeepSeek-main',
          type: 'RESTORE_TOOL_CALLS',
          records,
        });
      },
      onResponseComplete(fullText: string) {
        window.postMessage({
          source: 'WebTool-DeepSeek-main',
          type: 'RESPONSE_COMPLETE',
          text: fullText,
          userPrompt: latestUserPrompt,
        });
        // @Archived: [2026-11-20] 胶囊的临时排除清理已随功能下线移除。
      },
      onMemoriesUsed(ids: number[]) {
        window.postMessage({
          source: 'WebTool-DeepSeek-main',
          type: 'MEMORIES_USED',
          ids,
        });
      },
      onSkillUsed(name: string) {
        window.postMessage({
          source: 'WebTool-DeepSeek-main',
          type: 'SKILL_USED',
          name,
        });
      },
      onInjectionEvent(event) {
        window.postMessage({
          source: 'WebTool-DeepSeek-main',
          type: 'INJECTION_EVENT',
          data: event,
        });
      },
    });

    window.addEventListener('message', (event) => {
      if (event.data?.source !== 'WebTool-DeepSeek-content') return;

      // content 上报的工具块渲染状态（保证渲染效果的可观测出口）。
      if (event.data.type === 'RENDER_STATUS') {
        const diagnostics = ((window as unknown as Record<string, unknown>).__webtoolDeepseek ?? {}) as Record<string, unknown>;
        (window as unknown as Record<string, unknown>).__webtoolDeepseek = {
          ...diagnostics,
          render: event.data.data,
        };
        return;
      }

      switch (event.data.type) {
        case 'MEMORY_CONTENT_READ': {
          // memory_get 已读到正文：记录 id，下一次请求把正文以（全文）补注入上下文。
          recordMemoryToolRead(typeof event.data.key === 'string' ? event.data.key : '');
          break;
        }
        case 'SYNC_STATE': {
          const { memories, skills, presets, modelType, toolDescriptors, recognizedToolTags, memoryTokenBudget, memoryConfig, templateOverrides } = event.data as {
            memories: Memory[];
            skills: Skill[];
            presets: SystemPromptPreset[];
            modelType: ModelType;
            toolDescriptors?: ToolDescriptor[];
            recognizedToolTags?: string[];
            memoryTokenBudget?: number;
            memoryConfig?: MemoryConfig;
            templateOverrides?: TemplateOverrides;
          };
          latestMemories = memories;
          if (memoryConfig) latestMemoryConfig = memoryConfig;
          const activeMemoryConfig = memoryConfig ?? latestMemoryConfig;
          updateHookState({
            memories,
            skills,
            presets,
            modelType,
            toolDescriptors: toolDescriptors ?? [],
            recognizedToolTags: recognizedToolTags ?? [...DEFAULT_RECOGNIZED_TOOL_TAGS],
            templateOverrides,
            ...(activeMemoryConfig
              ? {
                  memoryTokenBudget: activeMemoryConfig.tokenBudget,
                  singleMemoryInjection: activeMemoryConfig.singleMemoryInjection === true,
                  customMemoryEnabled: activeMemoryConfig.customMemoryEnabled === true,
                  customMemoryPrompt: activeMemoryConfig.customMemoryPrompt,
                }
              : memoryTokenBudget !== undefined ? { memoryTokenBudget } : {}),
          });
          reprocessStoredHistory();
          initSkillPopup(skills);
          initMemoryPopup(activeMemoryConfig?.customMemoryEnabled === true ? [] : memories);
          initPresetPopup(presets);
          // @Archived: [2026-11-20] 胶囊状态同步已随功能下线移除。
          // 诊断出口：页面 console 输入 __webtoolDeepseek 即可确认注入链路是否就绪
          // （只暴露数量，不暴露记忆内容）。
          const diagnostics = ((window as unknown as Record<string, unknown>).__webtoolDeepseek ?? {}) as Record<string, unknown>;
          (window as unknown as Record<string, unknown>).__webtoolDeepseek = {
            ...diagnostics,
            ready: true,
            tools: toolDescriptors?.length ?? 0,
            memories: memories?.length ?? 0,
            presets: presets?.length ?? 0,
            updatedAt: Date.now(),
          };
          break;
        }
        case 'TEMPLATES_UPDATED': {
          const overrides = event.data.overrides as TemplateOverrides | undefined;
          updateHookState({ templateOverrides: overrides });
          break;
        }
        case 'SYNC_TOOL_DESCRIPTORS': {
          const { toolDescriptors, recognizedToolTags } = event.data as { toolDescriptors?: ToolDescriptor[]; recognizedToolTags?: string[] };
          updateHookState({ toolDescriptors: toolDescriptors ?? [], recognizedToolTags: recognizedToolTags ?? [...DEFAULT_RECOGNIZED_TOOL_TAGS] });
          reprocessStoredHistory();
          break;
        }
        case 'MEMORY_CONFIG_UPDATED': {
          const config = event.data as MemoryConfig;
          if (typeof config.tokenBudget === 'number' && config.tokenBudget > 0) {
            latestMemoryConfig = config;
            updateHookState({
              memoryTokenBudget: config.tokenBudget,
              singleMemoryInjection: config.singleMemoryInjection === true,
              customMemoryEnabled: config.customMemoryEnabled === true,
              customMemoryPrompt: typeof config.customMemoryPrompt === 'string' ? config.customMemoryPrompt : '',
            });
            initMemoryPopup(config.customMemoryEnabled === true ? [] : latestMemories);
            // @Archived: [2026-11-20] 胶囊状态同步已随功能下线移除。
          }
          break;
        }
        case 'SET_CONTINUATION_PROMPT': {
          // content 在触发自动续聊前设置挂起的 continuation prompt，
          // fetch-hook 拦截到下一个 completion 请求时用它替换用户输入。
          const prompt = typeof event.data.prompt === 'string' ? event.data.prompt : null;
          updateHookState({
            pendingContinuationPrompt: prompt,
            pendingContinuationAt: prompt ? Date.now() : 0,
          });
          break;
        }
      }
    });
  },
});

function getChatSessionIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/\/chat\/s\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function watchRouteChanges() {
  let lastPathname = window.location.pathname;

  const notifyIfChanged = () => {
    if (lastPathname === window.location.pathname) return;
    lastPathname = window.location.pathname;
    const chatSessionId = getChatSessionIdFromPathname(lastPathname);
    if (chatSessionId) {
      // 新对话首条消息发送时可能还没有真实 session id，路由落定后再补绑定单次注入状态。
      bindPendingSingleInjectionSession(chatSessionId);
    }
    window.postMessage({
      source: 'WebTool-DeepSeek-main',
      type: 'ROUTE_CHANGED',
      pathname: lastPathname,
    });
  };

  const watchHistoryMethod = (method: 'pushState' | 'replaceState') => {
    const original = history[method];
    history[method] = function (this: History, ...args) {
      const result = original.apply(this, args);
      setTimeout(notifyIfChanged, 0);
      return result;
    } as typeof history[typeof method];
  };

  watchHistoryMethod('pushState');
  watchHistoryMethod('replaceState');
  window.addEventListener('popstate', notifyIfChanged);
}
