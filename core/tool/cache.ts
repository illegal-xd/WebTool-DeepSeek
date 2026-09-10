export const TOOL_EXECUTION_CACHE_PREFIX = 'dpp_tool_exec_';
export const TOOL_EXECUTION_CACHE_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

export interface ToolExecutionCacheStorage {
  get(keys?: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ToolExecutionCacheCleanupResult {
  deletedRecords: number;
  removedKeys: number;
}

function isExpiredRecord(value: unknown, now: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const timestamp = (value as { timestamp?: unknown }).timestamp;
  return typeof timestamp === 'number'
    && Number.isFinite(timestamp)
    && now - timestamp > TOOL_EXECUTION_CACHE_MAX_AGE_MS;
}

export async function clearExpiredToolExecutionCache(
  storage: ToolExecutionCacheStorage,
  now = Date.now(),
): Promise<ToolExecutionCacheCleanupResult> {
  const stored = await storage.get(null);
  const updates: Record<string, unknown> = {};
  const emptyKeys: string[] = [];
  let deletedRecords = 0;

  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(TOOL_EXECUTION_CACHE_PREFIX) || !Array.isArray(value)) continue;
    const retained = value.filter((record) => !isExpiredRecord(record, now));
    deletedRecords += value.length - retained.length;
    if (retained.length === 0 && value.length > 0) emptyKeys.push(key);
    else if (retained.length !== value.length) updates[key] = retained;
  }

  if (Object.keys(updates).length > 0) await storage.set(updates);
  if (emptyKeys.length > 0) await storage.remove(emptyKeys);
  return { deletedRecords, removedKeys: emptyKeys.length };
}
