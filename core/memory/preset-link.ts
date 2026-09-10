/**
 * 记忆-预设重合度计算
 *
 * 当用户启用了某预设且记忆内容与预设高度重合时，记忆注入会关联对应预设，
 * 让 DeepSeek 在回答时同时参考预设指令与记忆内容，提高一致性。
 */
import type { Memory, SystemPromptPreset } from '../types';

/** 重合度阈值：≥ 此值视为「高度重合」，触发关联注入。 */
export const PRESET_LINK_THRESHOLD = 0.3;

/** 单条记忆与预设内容的重合度（0-1）。 */
export function memoryPresetOverlap(memory: Memory, preset: SystemPromptPreset): number {
  const memoryWords = tokenize(`${memory.name} ${memory.content} ${memory.tags.join(' ')}`);
  const presetWords = tokenize(preset.content);
  if (memoryWords.size === 0 || presetWords.size === 0) return 0;

  let hit = 0;
  for (const word of memoryWords) {
    if (presetWords.has(word)) hit += 1;
  }
  // 按记忆词在预设中的覆盖率（记忆词量较小，覆盖率更能反映「记忆贴合预设」）。
  const coverage = hit / memoryWords.size;
  const jaccard = hit / (memoryWords.size + presetWords.size - hit);
  return Math.max(coverage, jaccard);
}

/**
 * 将文本分词为关键词集合。注意：这里与 selector.segmentText 的契约不同——使用 2-3 字滑窗 + 英文词，
 * 不依赖 Intl.Segmenter、不过滤停用词：重合度计算看重「字面贴合」，属有意与注入选择的分词策略分离。
 */
function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = new Set<string>();
  // 中文按字符分段匹配（2-3 字窗口），英文按词。
  const cjk = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const chunk of cjk) {
    for (let i = 0; i < chunk.length - 1; i++) {
      words.add(chunk.slice(i, i + 2));
      if (i + 2 < chunk.length) words.add(chunk.slice(i, i + 3));
    }
  }
  for (const match of lower.match(/[a-z0-9_+-]{2,}/g) ?? []) {
    words.add(match);
  }
  return words;
}

/** 记忆内容与活动预设高度重合时返回对应预设，否则返回 null。 */
export function findPresetForMemory(memory: Memory, presets: SystemPromptPreset[]): SystemPromptPreset | null {
  if (presets.length === 0) return null;
  let best: SystemPromptPreset | null = null;
  let bestScore = 0;
  for (const preset of presets) {
    const score = memoryPresetOverlap(memory, preset);
    if (score > bestScore) {
      bestScore = score;
      best = preset;
    }
  }
  return bestScore >= PRESET_LINK_THRESHOLD ? best : null;
}
