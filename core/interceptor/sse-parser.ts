import type { SSEEvent } from '../types';

export function parseSSEChunk(chunk: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = chunk.split('\n\n');

  for (const block of blocks) {
    if (!block.trim()) continue;

    const event: Partial<SSEEvent> = {};
    const lines = block.split('\n');

    for (const line of lines) {
      if (line.startsWith('id:')) {
        event.id = line.slice(3).trim();
      } else if (line.startsWith('event:')) {
        event.type = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        event.data = (event.data ?? '') + line.slice(5).trim();
      }
    }

    if (event.data !== undefined) {
      events.push({
        type: event.type ?? 'message',
        data: event.data,
        id: event.id,
      });
    }
  }

  return events;
}

export function parseSSEData(data: string): unknown | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function extractTextFromParsed(parsed: any): string | null {
  if (typeof parsed.v === 'string') {
    return parsed.v;
  }
  if (parsed.p && parsed.o === 'APPEND' && typeof parsed.v === 'string') {
    return parsed.v;
  }
  // BATCH format: {"o":"BATCH", "v":[...]}
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    for (const item of parsed.v) {
      const text = extractTextFromParsed(item);
      if (text) return text;
    }
    return null;
  }
  // Direct content setting: {"p":".../content", "v":"text"}
  if (parsed.p && parsed.p.endsWith('/content') && typeof parsed.v === 'string') {
    return parsed.v;
  }
  // Fragment creation: {"p":"response/fragments","o":"APPEND","v":[{content:"text",...}]}
  if (
    parsed.p &&
    parsed.p.endsWith('/fragments') &&
    parsed.o === 'APPEND' &&
    Array.isArray(parsed.v)
  ) {
    for (const frag of parsed.v) {
      if (typeof frag.content === 'string') {
        return frag.content;
      }
    }
    return null;
  }
  return null;
}

export function isStreamFinishedFromParsed(parsed: any): boolean {
  if (parsed.p === 'response/status' && parsed.v === 'FINISHED') return true;
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    return parsed.v.some(
      (item: { p: string; v: string }) => item.p === 'quasi_status' && item.v === 'FINISHED',
    );
  }
  return false;
}
