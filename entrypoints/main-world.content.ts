import { installFetchHook, updateHookState, reprocessStoredHistory, bindPendingSingleInjectionSession } from '../core/interceptor/fetch-hook';
import type { MemoryConfig } from '../core/memory/config';
import { initSkillPopup } from '../core/ui/skill-popup';
import { initMemoryPopup } from '../core/ui/memory-popup';
import { initPresetPopup } from '../core/ui/preset-popup';
import { updatePresetTag } from '../core/ui/preset-tag';
import { DEFAULT_RECOGNIZED_TOOL_TAGS } from '../core/tool';
import type { Memory, ModelType, Skill, SystemPromptPreset, ToolCall, ToolCardResult, ToolCallRestoreRecord, ToolDescriptor } from '../core/types';

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // fetch/XHR 必须在 MAIN world 拦截，content world 只负责 UI 与扩展 API 桥接。
    installFetchHook();
    watchRouteChanges();

    updateHookState({
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
        });
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
    });

    window.addEventListener('message', (event) => {
      if (event.data?.source !== 'WebTool-DeepSeek-content') return;

      switch (event.data.type) {
        case 'SYNC_STATE': {
          const { memories, skills, presets, activePreset, modelType, toolDescriptors, recognizedToolTags, memoryTokenBudget } = event.data as {
            memories: Memory[];
            skills: Skill[];
            presets: SystemPromptPreset[];
            activePreset: SystemPromptPreset | null;
            modelType: ModelType;
            toolDescriptors?: ToolDescriptor[];
            recognizedToolTags?: string[];
            memoryTokenBudget?: number;
          };
          updateHookState({
            memories,
            skills,
            activePreset,
            modelType,
            toolDescriptors: toolDescriptors ?? [],
            recognizedToolTags: recognizedToolTags ?? [...DEFAULT_RECOGNIZED_TOOL_TAGS],
            ...(memoryTokenBudget !== undefined ? { memoryTokenBudget } : {}),
          });
          reprocessStoredHistory();
          initSkillPopup(skills);
          initMemoryPopup(memories);
          initPresetPopup(presets);
          updatePresetTag(activePreset);
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
            updateHookState({
              memoryTokenBudget: config.tokenBudget,
              singleMemoryInjection: config.singleMemoryInjection === true,
            });
          }
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
