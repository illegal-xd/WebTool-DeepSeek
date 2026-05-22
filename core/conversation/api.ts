import type { ConversationMessage, ConversationSession } from '../types';

const API_BASE = 'https://chat.deepseek.com/api/v0';
const APP_VERSION = '2.0.0';
const DEFAULT_SESSION_PAGE_SIZE = 50;
const SESSION_FETCH_PAGE_DELAY_MS = 350;

interface DeepSeekTokenRecord {
  value?: string;
}

function getToken(): string | null {
  const raw = localStorage.getItem('userToken');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DeepSeekTokenRecord | string;
    return typeof parsed === 'string' ? parsed : parsed.value ?? null;
  } catch {
    return raw;
  }
}

async function deepseekApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = getToken();
  if (!token) throw new Error('未找到 userToken，请先登录 DeepSeek');

  const timezoneOffsetSeconds = String(-new Date().getTimezoneOffset() * 60);
  const clientLocale = navigator.language.replace('-', '_');
  const requestUrl = `${API_BASE}${path}`;

  const response = await fetch(requestUrl, {
    method,
    credentials: 'include',
    cache: 'no-store',
    referrer: window.location.href,
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-App-Version': APP_VERSION,
      'X-Client-Locale': clientLocale,
      'X-Client-Platform': 'web',
      'X-Client-Timezone-Offset': timezoneOffsetSeconds,
      'X-Client-Version': APP_VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API 请求失败：${response.status}`);
  }

  const json = await response.json();
  if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
    throw new Error(json.msg || `DeepSeek API 错误：${json.code}`);
  }

  return (json?.data ?? json) as T;
}

function toTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeSession(raw: Record<string, unknown>): ConversationSession | null {
  const id = raw.id ?? raw.chat_session_id ?? raw.chatSessionId;
  if (typeof id !== 'string' || id.length === 0) return null;

  return {
    id,
    title: String(raw.title ?? raw.name ?? '未命名对话'),
    updatedAt: toTimestamp(raw.updated_at ?? raw.updatedAt ?? raw.update_time ?? raw.updateTime),
    createdAt: toTimestamp(raw.created_at ?? raw.createdAt ?? raw.create_time ?? raw.createTime),
    messageCount: typeof raw.message_count === 'number'
      ? raw.message_count
      : typeof raw.messageCount === 'number'
        ? raw.messageCount
        : undefined,
    modelType: typeof raw.model_type === 'string'
      ? raw.model_type
      : typeof raw.modelType === 'string'
        ? raw.modelType
        : undefined,
    pinned: Boolean(raw.pinned),
  };
}

function extractSessionList(data: unknown): ConversationSession[] {
  const record = data as Record<string, unknown> | undefined;
  const biz = (record?.biz_data ?? record?.data ?? record) as Record<string, unknown> | undefined;
  const rawList = biz?.chat_sessions ?? biz?.sessions ?? biz?.list ?? data;
  const list = Array.isArray(rawList) ? rawList : [];
  return list
    .map((item) => normalizeSession(item as Record<string, unknown>))
    .filter((item): item is ConversationSession => item !== null);
}

function extractHasMore(data: unknown): boolean {
  const record = data as Record<string, unknown> | undefined;
  const biz = (record?.biz_data ?? record?.data ?? record) as Record<string, unknown> | undefined;
  return Boolean(biz?.has_more ?? biz?.hasMore);
}

function getNextCursorFromPage(sessions: ConversationSession[]): string | null {
  if (sessions.length === 0) return null;
  const last = sessions[sessions.length - 1];
  return String(last.updatedAt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listDeepSeekSessions(): Promise<ConversationSession[]> {
  const allSessions: ConversationSession[] = [];
  let updatedAtCursor: string | null = null;

  for (let safety = 0; safety < 100; safety++) {
    let path = `/chat_session/fetch_page?lte_cursor.pinned=false`; // count=${DEFAULT_SESSION_PAGE_SIZE}
    if (updatedAtCursor) {
      path += `&lte_cursor.updated_at=${encodeURIComponent(updatedAtCursor)}`;
    }

    const data = await deepseekApi<unknown>(path);
    const pageSessions = extractSessionList(data);
    if (pageSessions.length === 0) break;

    const dedup = new Map(allSessions.map((session) => [session.id, session]));
    for (const session of pageSessions) dedup.set(session.id, session);
    allSessions.splice(0, allSessions.length, ...Array.from(dedup.values()));

    const hasMore = extractHasMore(data);
    if (!hasMore) break;

    const nextCursor = getNextCursorFromPage(pageSessions);
    if (!nextCursor || nextCursor === updatedAtCursor) break;
    updatedAtCursor = nextCursor;

    await sleep(SESSION_FETCH_PAGE_DELAY_MS);
  }

  return allSessions.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDeepSeekSession(id: string): Promise<void> {
  await deepseekApi('/chat_session/delete', 'POST', { chat_session_id: id });
}

export async function renameDeepSeekSession(id: string, title: string): Promise<void> {
  await deepseekApi('/chat_session/update_title', 'POST', { chat_session_id: id, title });
}

function normalizeRole(value: unknown): ConversationMessage['role'] | null {
  if (typeof value !== 'string') return null;
  const role = value.toLowerCase();
  if (role === 'user' || role === 'human' || role === 'question') return 'user';
  if (role === 'assistant' || role === 'bot' || role === 'assistant_message' || role === 'answer') return 'assistant';
  if (role === 'system' || role === 'tool' || role === 'developer') return 'system';
  return null;
}

function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => readText((item as Record<string, unknown>)?.text ?? item)).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return readText(record.text ?? record.content ?? record.message ?? record.value ?? record.answer ?? record.reply);
  }
  return '';
}

function normalizeFragmentType(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : '';
}

function extractMessageContent(raw: Record<string, unknown>, role: ConversationMessage['role']): string {
  const fragments = Array.isArray(raw.fragments) ? raw.fragments : [];
  if (fragments.length > 0) {
    const normalizedFragments = fragments
      .filter((fragment): fragment is Record<string, unknown> => Boolean(fragment) && typeof fragment === 'object' && !Array.isArray(fragment))
      .map((fragment) => ({
        type: normalizeFragmentType(fragment.type ?? fragment.fragment_type ?? fragment.kind),
        content: readText(fragment.content ?? fragment.text ?? fragment.message ?? fragment.value),
      }))
      .filter((fragment) => fragment.content.length > 0);

    if (role === 'user') {
      const requestFragment = normalizedFragments.find((fragment) => fragment.type === 'REQUEST');
      if (requestFragment) return requestFragment.content;
    }

    if (role === 'assistant') {
      const responseFragment = normalizedFragments.find((fragment) => fragment.type === 'RESPONSE');
      if (responseFragment) return responseFragment.content;
    }

    const preferredFragments = normalizedFragments.filter((fragment) => !['THINK', 'TIP'].includes(fragment.type));
    if (preferredFragments.length > 0) {
      return preferredFragments.map((fragment) => fragment.content).join('\n');
    }

    return normalizedFragments.map((fragment) => fragment.content).join('\n');
  }

  return '';
}

function normalizeMessage(raw: Record<string, unknown>, sessionId: string): ConversationMessage | null {
  const idValue = raw.id ?? raw.message_id ?? raw.messageId ?? raw.msg_id ?? raw.mid;
  const role = normalizeRole(raw.role ?? raw.sender ?? raw.message_role ?? raw.author ?? raw.type ?? raw.message_type ?? raw.display_role);
  if (!role) return null;

  const id = typeof idValue === 'string' ? idValue : idValue != null ? String(idValue) : '';
  if (!id) return null;

  const content = extractMessageContent(raw, role)
    || readText(raw.content ?? raw.text ?? raw.message ?? raw.answer ?? raw.reply ?? raw.prompt);

  if (!content) return null;

  return {
    id,
    sessionId,
    role,
    content,
    createdAt: toTimestamp(raw.created_at ?? raw.createdAt ?? raw.inserted_at ?? raw.insertedAt ?? raw.timestamp ?? raw.create_time),
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : undefined,
  };
}

function extractHistoryMessages(data: unknown): Record<string, unknown>[] {
  const record = data as Record<string, unknown> | undefined;
  const bizData = record?.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : record?.biz_data && typeof record.biz_data === 'object'
      ? (record.biz_data as Record<string, unknown>)
      : undefined;

  const chatMessages = bizData?.chat_messages;
  if (!Array.isArray(chatMessages)) return [];

  return chatMessages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

export async function getDeepSeekSessionHistory(sessionId: string): Promise<ConversationMessage[]> {
  const data = await deepseekApi<unknown>(`/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`);// &cache_version=-1
  return extractHistoryMessages(data)
    .map((item) => normalizeMessage(item, sessionId))
    .filter((item): item is ConversationMessage => item !== null);
}
