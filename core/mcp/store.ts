import { getLocalValue, setLocalValue } from '../storage/chrome';
import type { McpHeaderValue, McpSecretValue, McpServerConfig, McpServerCreateInput, McpServerId, McpServerStorageState, McpServerTimeouts, McpServerUpdateInput, McpToolCacheEntry } from './types';

const STORAGE_KEY = 'webtool_deepseek_mcp_servers';
const STORAGE_VERSION = 1;
const REDACTED_SECRET_VALUE = '********';

const DEFAULT_TIMEOUTS: McpServerTimeouts = { connectMs: 10_000, requestMs: 60_000, discoveryMs: 20_000 };
const EMPTY_STATE: McpServerStorageState = { version: STORAGE_VERSION, servers: [], toolCaches: [] };

export async function getAllMcpServers(options?: { includeSecrets?: boolean }): Promise<McpServerConfig[]> {
  const state = await readState();
  const servers = [...state.servers].sort((a, b) => b.updatedAt - a.updatedAt);
  return options?.includeSecrets ? servers : servers.map(sanitizeMcpServerConfig);
}

export async function getMcpServerById(id: McpServerId, options?: { includeSecrets?: boolean }): Promise<McpServerConfig | null> {
  const server = (await readState()).servers.find((item) => item.id === id) ?? null;
  if (!server) return null;
  return options?.includeSecrets ? server : sanitizeMcpServerConfig(server);
}

export async function createMcpServer(input: McpServerCreateInput): Promise<McpServerConfig> {
  const state = await readState();
  const now = Date.now();
  const server = normalizeServer({
    version: STORAGE_VERSION,
    id: crypto.randomUUID(),
    displayName: input.displayName,
    enabled: input.enabled ?? true,
    transport: input.transport,
    headers: input.headers ?? [],
    secrets: input.secrets ?? [],
    timeouts: input.timeouts ?? DEFAULT_TIMEOUTS,
    limits: input.limits ?? { maxResultBytes: 64_000, maxToolCount: 128 },
    allowlist: input.allowlist ?? { mode: 'all', toolNames: [] },
    execution: input.execution ?? { mode: 'auto', enabled: true },
    status: input.enabled === false ? 'disabled' : 'unknown',
    lastConnectedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  await writeState({ ...state, servers: [server, ...state.servers.filter((item) => item.id !== server.id)] });
  return sanitizeMcpServerConfig(server);
}

export async function updateMcpServer(id: McpServerId, patch: McpServerUpdateInput): Promise<McpServerConfig | null> {
  const state = await readState();
  let updated: McpServerConfig | null = null;
  const invalidations = new Set<McpServerId>();
  const servers = state.servers.map((server) => {
    if (server.id !== id) return server;
    const nextPatch = patch.secrets ? { ...patch, secrets: mergeRedactedSecrets(server.secrets, patch.secrets) } : patch;
    const nextServer = normalizeServer({ ...server, ...nextPatch, updatedAt: Date.now(), status: nextPatch.enabled === false ? 'disabled' : nextPatch.status ?? server.status });
    if (shouldInvalidateMcpToolCache(server, nextServer)) {
      invalidations.add(server.id);
      updated = { ...nextServer, status: nextServer.enabled ? 'unknown' : 'disabled', lastConnectedAt: null, lastError: null };
      return updated;
    }
    updated = nextServer;
    return updated;
  });
  if (!updated) return null;
  await writeState({ ...state, servers, toolCaches: invalidations.size ? state.toolCaches.filter((cache) => !invalidations.has(cache.serverId)) : state.toolCaches });
  return sanitizeMcpServerConfig(updated);
}

export async function deleteMcpServer(id: McpServerId): Promise<void> {
  const state = await readState();
  await writeState({ ...state, servers: state.servers.filter((server) => server.id !== id), toolCaches: state.toolCaches.filter((cache) => cache.serverId !== id) });
}

export async function getMcpToolCache(serverId: McpServerId): Promise<McpToolCacheEntry | null> {
  return (await readState()).toolCaches.find((cache) => cache.serverId === serverId) ?? null;
}

export async function getAllMcpToolCaches(): Promise<McpToolCacheEntry[]> {
  return [...(await readState()).toolCaches].sort((a, b) => b.refreshedAt - a.refreshedAt);
}

export async function saveMcpToolCache(entry: McpToolCacheEntry): Promise<void> {
  const state = await readState();
  await writeState({ ...state, toolCaches: [entry, ...state.toolCaches.filter((cache) => cache.serverId !== entry.serverId)] });
}

export function sanitizeMcpServerConfig(server: McpServerConfig): McpServerConfig {
  return { ...server, secrets: server.secrets.map(redactSecret) };
}

export function buildMcpRequestHeaders(server: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of server.headers) if (header.name.trim()) headers[header.name.trim()] = header.value;
  for (const secret of server.secrets) {
    if (!secret.value) continue;
    if (secret.kind === 'bearer') headers.Authorization = `Bearer ${secret.value}`;
    if (secret.kind === 'basic') headers.Authorization = `Basic ${secret.value}`;
    if (secret.kind === 'header' && secret.headerName?.trim()) headers[secret.headerName.trim()] = secret.value;
  }
  return headers;
}

async function readState(): Promise<McpServerStorageState> {
  return getLocalValue(STORAGE_KEY, { ...EMPTY_STATE }, normalizeState);
}

async function writeState(state: McpServerStorageState): Promise<void> {
  const normalized = normalizeState(state);
  await setLocalValue(STORAGE_KEY, {
    version: STORAGE_VERSION,
    servers: normalized.servers,
    toolCaches: normalized.toolCaches,
  });
}

function normalizeState(raw: unknown): McpServerStorageState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE };
  const value = raw as Partial<McpServerStorageState>;
  return { version: STORAGE_VERSION, servers: Array.isArray(value.servers) ? value.servers.map(normalizeServer) : [], toolCaches: Array.isArray(value.toolCaches) ? value.toolCaches.map(normalizeToolCache).filter((cache): cache is McpToolCacheEntry => cache !== null) : [] };
}

function normalizeServer(raw: unknown): McpServerConfig {
  const value = raw && typeof raw === 'object' ? raw as Partial<McpServerConfig> : {};
  const now = Date.now();
  const enabled = value.enabled !== false;
  return {
    version: STORAGE_VERSION,
    id: stringValue(value.id) || crypto.randomUUID(),
    displayName: stringValue(value.displayName) || 'MCP 服务',
    enabled,
    transport: { kind: value.transport?.kind ?? 'streamable_http', url: stringValue(value.transport?.url), nativeHost: stringValue(value.transport?.nativeHost), command: stringValue(value.transport?.command), args: stringArrayValue(value.transport?.args), cwd: stringValue(value.transport?.cwd), env: stringRecordValue(value.transport?.env) },
    headers: headerArrayValue(value.headers),
    secrets: secretArrayValue(value.secrets),
    timeouts: { connectMs: positiveNumber(value.timeouts?.connectMs, DEFAULT_TIMEOUTS.connectMs), requestMs: positiveNumber(value.timeouts?.requestMs, DEFAULT_TIMEOUTS.requestMs), discoveryMs: positiveNumber(value.timeouts?.discoveryMs, DEFAULT_TIMEOUTS.discoveryMs) },
    limits: { maxResultBytes: positiveNumber(value.limits?.maxResultBytes, 64_000), maxToolCount: positiveNumber(value.limits?.maxToolCount, 128) },
    allowlist: { mode: value.allowlist?.mode ?? 'all', toolNames: stringArrayValue(value.allowlist?.toolNames) },
    execution: { mode: value.execution?.mode ?? 'auto', enabled: value.execution?.enabled !== false },
    status: enabled ? value.status ?? 'unknown' : 'disabled',
    lastConnectedAt: nullableNumber(value.lastConnectedAt),
    lastError: stringValue(value.lastError) || null,
    createdAt: positiveNumber(value.createdAt, now),
    updatedAt: positiveNumber(value.updatedAt, now),
  };
}

function normalizeToolCache(raw: unknown): McpToolCacheEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<McpToolCacheEntry>;
  if (!value.serverId) return null;
  return { serverId: value.serverId, descriptors: Array.isArray(value.descriptors) ? value.descriptors : [], refreshedAt: positiveNumber(value.refreshedAt, 0), expiresAt: positiveNumber(value.expiresAt, 0), health: value.health ?? { serverId: value.serverId, status: 'unknown', checkedAt: 0, latencyMs: null, toolCount: 0, error: null } };
}

function shouldInvalidateMcpToolCache(prev: McpServerConfig, next: McpServerConfig): boolean {
  return JSON.stringify(prev.transport) !== JSON.stringify(next.transport) || JSON.stringify(prev.headers) !== JSON.stringify(next.headers) || JSON.stringify(prev.secrets) !== JSON.stringify(next.secrets) || JSON.stringify(prev.allowlist) !== JSON.stringify(next.allowlist) || JSON.stringify(prev.execution) !== JSON.stringify(next.execution);
}

function mergeRedactedSecrets(previous: McpSecretValue[], next: McpSecretValue[]): McpSecretValue[] {
  return next.map((secret) => secret.value === REDACTED_SECRET_VALUE ? previous.find((item) => item.id && item.id === secret.id) ?? { ...secret, value: '' } : secret);
}

function redactSecret(secret: McpSecretValue): McpSecretValue {
  return { ...secret, value: secret.value ? REDACTED_SECRET_VALUE : '' };
}

function headerArrayValue(value: unknown): McpHeaderValue[] {
  return Array.isArray(value) ? value.map((item) => item && typeof item === 'object' ? item as Partial<McpHeaderValue> : null).filter((item): item is Partial<McpHeaderValue> => item !== null).map((item) => ({ name: stringValue(item.name), value: stringValue(item.value) })).filter((item) => item.name) : [];
}

function secretArrayValue(value: unknown): McpSecretValue[] {
  return Array.isArray(value) ? value.map((item) => item && typeof item === 'object' ? item as Partial<McpSecretValue> : null).filter((item): item is Partial<McpSecretValue> => item !== null).map((item) => ({ id: stringValue(item.id) || crypto.randomUUID(), kind: item.kind ?? 'bearer', headerName: stringValue(item.headerName), username: stringValue(item.username), value: stringValue(item.value) })) : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
