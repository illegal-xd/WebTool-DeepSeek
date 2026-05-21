import { installFetchHook, updateHookState } from '../core/interceptor/fetch-hook';
import { initSkillPopup } from '../core/ui/skill-popup';
import { initMemoryPopup } from '../core/ui/memory-popup';
import type { Memory, ModelType, Skill, SystemPromptPreset, ToolCall } from '../core/types';

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installFetchHook();

    updateHookState({
      onToolCall(call: ToolCall) {
        window.postMessage({
          source: 'WebTool-DeepSeek-main',
          type: 'TOOL_CALL',
          data: call,
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
    });

    window.addEventListener('message', (event) => {
      if (event.data?.source !== 'WebTool-DeepSeek-content') return;

      switch (event.data.type) {
        case 'SYNC_STATE': {
          const { memories, skills, activePreset, modelType } = event.data as {
            memories: Memory[];
            skills: Skill[];
            activePreset: SystemPromptPreset | null;
            modelType: ModelType;
          };
          updateHookState({ memories, skills, activePreset, modelType });
          initSkillPopup(skills);
          initMemoryPopup(memories);
          break;
        }
      }
    });
  },
});
