import type { SystemPromptPreset } from '../types';

/**
 * 解析输入框开头的 `@预设名` mention —— 按条生效，不保留全局激活状态。
 *
 * - 与 `/skill`、`#记忆` 一致：mention 只对当条消息生效，发送时剥离，不进入用户正文；
 * - 多个预设名互为前缀时取最长匹配（如「严谨」与「严谨模式」）；
 * - 纯 mention（后面没有正文）不视为触发，原样交给后续分支，避免产生空 prompt。
 */
export function resolvePresetMention(
  prompt: string,
  presets: readonly SystemPromptPreset[],
): { preset: SystemPromptPreset; rest: string } | null {
  if (!prompt.startsWith('@')) return null;
  const body = prompt.slice(1);

  let matched: { preset: SystemPromptPreset; rest: string } | null = null;
  for (const preset of presets) {
    const name = preset.name?.trim();
    if (!name || !body.startsWith(name)) continue;

    const boundary = body.slice(name.length);
    if (boundary.length > 0 && !/^\s/.test(boundary)) continue;

    const rest = boundary.replace(/^\s+/, '');
    if (rest.length === 0) continue; // 纯 mention：不触发

    const matchedLength = matched?.preset.name?.trim().length ?? 0;
    if (name.length > matchedLength) matched = { preset, rest };
  }
  return matched;
}
