/**
 * 注入事件记录 — 类型与存储
 *
 * fetch-hook（MAIN world）在每次触发注入时发出 INJECTION_EVENT，
 * 经 content script 转发到 background 持久化，供 sidepanel 时间轴展示。
 */
import { getLocalValue, setLocalValue } from '../storage/chrome';

export type InjectionKind = 'memory' | 'preset' | 'prompt' | 'skill' | 'mcp';

export interface InjectionEvent {
  id: number;
  ts: number;
  kind: InjectionKind;
  title: string;
  detail?: string;
  /** 全量注入数据（augmented prompt 或核心注入文本），供用户审查。 */
  payload?: string;
  sessionId?: string | null;
}

const STORAGE_KEY = 'webtool_deepseek_injection_events';
const MAX_EVENTS = 100;

let nextEventId = 0;

function nextId(): number {
  nextEventId += 1;
  return nextEventId;
}

export function createInjectionEvent(input: Omit<InjectionEvent, 'id' | 'ts'>): InjectionEvent {
  // payload 截断保护，避免存储超限。
  const payload = input.payload && input.payload.length > 16_000
    ? `${input.payload.slice(0, 16_000)}\n...[已截断，共 ${input.payload.length} 字符]`
    : input.payload;
  return { ...input, payload, id: nextId(), ts: Date.now() };
}

export async function getInjectionEvents(): Promise<InjectionEvent[]> {
  return getLocalValue(STORAGE_KEY, [], normalizeInjectionEvents);
}

/** 追加事件并截断到上限。返回截断后的事件列表。 */
export async function appendInjectionEvent(event: InjectionEvent): Promise<InjectionEvent[]> {
  const current = await getInjectionEvents();
  const capped = [...current, event].slice(-MAX_EVENTS);
  await setLocalValue(STORAGE_KEY, capped);
  return capped;
}

export async function clearInjectionEvents(): Promise<void> {
  await setLocalValue(STORAGE_KEY, []);
}

function normalizeInjectionEvents(raw: unknown): InjectionEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is InjectionEvent => Boolean(item) && typeof item === 'object' && typeof (item as InjectionEvent).ts === 'number')
    .slice(-MAX_EVENTS);
}
