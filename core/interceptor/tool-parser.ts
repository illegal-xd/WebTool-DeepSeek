import { TOOL_CALLS_BLOCK_REGEX, INVOKE_REGEX, PARAMETER_REGEX, TOOL_CALL_REGEX } from '../constants';
import type { ToolCall } from '../types';

function extractXmlToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = new RegExp(TOOL_CALL_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const jsonStr = match[2];
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(jsonStr);
    } catch {
      continue;
    }
    calls.push({ name, payload, raw: match[0] });
  }

  return calls;
}

function extractLegacyToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const blockRegex = new RegExp(TOOL_CALLS_BLOCK_REGEX.source, 'g');
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[0];
    const invokeRegex = new RegExp(INVOKE_REGEX.source, 'g');
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokeRegex.exec(blockContent)) !== null) {
      const name = invokeMatch[1];
      const invokeContent = invokeMatch[2];
      const payload: Record<string, unknown> = {};
      const paramRegex = new RegExp(PARAMETER_REGEX.source, 'g');
      let paramMatch: RegExpExecArray | null;

      while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
        const paramName = paramMatch[1];
        const isString = paramMatch[2] === 'true';
        const value = paramMatch[3];
        if (isString) {
          payload[paramName] = value;
        } else {
          try {
            payload[paramName] = JSON.parse(value);
          } catch {
            payload[paramName] = value;
          }
        }
      }

      calls.push({ name, payload, raw: blockMatch[0] });
    }
  }

  return calls;
}

export function extractToolCalls(text: string): ToolCall[] {
  return [
    ...extractXmlToolCalls(text),
    ...extractLegacyToolCalls(text),
  ];
}

export function stripToolCalls(text: string): string {
  // Strip both legacy DSML blocks and new XML blocks
  let result = text.replace(new RegExp(TOOL_CALLS_BLOCK_REGEX.source, 'g'), '');
  result = result.replace(new RegExp(TOOL_CALL_REGEX.source, 'g'), '');
  return result.trim();
}

export function replaceToolCallsWithSummary(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inBlock = false;
  let callCount = 0;

  for (const line of lines) {
    if (TOOL_CALL_REGEX.test(line)) {
      TOOL_CALL_REGEX.lastIndex = 0;
      callCount++;
      if (!inBlock) {
        inBlock = true;
      }
      continue;
    }
    if (TOOL_CALLS_BLOCK_REGEX.test(line)) {
      TOOL_CALLS_BLOCK_REGEX.lastIndex = 0;
      callCount++;
      if (!inBlock) {
        inBlock = true;
      }
      continue;
    }
    if (inBlock) {
      result.push(`🔧 已执行工具（${callCount}次）`);
      inBlock = false;
      callCount = 0;
    }
    result.push(line);
  }

  if (inBlock) {
    result.push(`🔧 已执行工具（${callCount}次）`);
  }

  return result.join('\n');
}

export function replaceMatchWithSummary(match: string): string {
  const isXmlBlock = TOOL_CALL_REGEX.test(match);
  return isXmlBlock ? '🔧 已执行工具（1次）' : '🔧 已执行工具（1次）';
}