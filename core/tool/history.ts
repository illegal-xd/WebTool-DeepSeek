import type { ToolCall, ToolCallHistoryRecord, ToolExecutionTrigger, ToolResult } from './types';

const STORAGE_KEY = 'webtool_deepseek_tool_history';
const MAX_HISTORY = 200;

export async function appendToolCallHistory(call: ToolCall, result: ToolResult, source: ToolExecutionTrigger): Promise<ToolCallHistoryRecord> {
  const record: ToolCallHistoryRecord = { id: crypto.randomUUID(), call: sanitizeCall(call), result: sanitizeResult(result), source, createdAt: Date.now() };
  const history = await getToolCallHistory();
  await chrome.storage.local.set({ [STORAGE_KEY]: [record, ...history].slice(0, MAX_HISTORY) });
  return record;
}

export async function getToolCallHistory(limit: number = MAX_HISTORY): Promise<ToolCallHistoryRecord[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
  const raw = data[STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is ToolCallHistoryRecord => Boolean(item && typeof item === 'object')).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function clearToolCallHistory(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

function sanitizeCall(call: ToolCall): ToolCall {
  return { ...call, payload: truncateRecord(call.payload, 8_000), raw: call.raw.length > 8_000 ? `${call.raw.slice(0, 8_000)}\n...[truncated]` : call.raw };
}

function sanitizeResult(result: ToolResult): ToolResult {
  return {
    ...result,
    detail: truncateString(result.detail, 8_000),
    output: result.output === undefined ? undefined : truncateString(JSON.stringify(result.output), 16_000),
    error: result.error ? { ...result.error, message: truncateString(result.error.message, 4_000) ?? '', details: result.error.details ? truncateRecord(result.error.details, 4_000) : undefined } : undefined,
  };
}

function truncateRecord(value: Record<string, unknown>, maxLength: number): Record<string, unknown> {
  const json = JSON.stringify(value);
  return json.length <= maxLength ? value : { truncated: true, preview: json.slice(0, maxLength) };
}

function truncateString(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}
