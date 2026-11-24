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

/** 思考/推理片段类型：只用于展示，不能参与工具调用解析。 */
const NON_CONTENT_FRAGMENT_TYPES = new Set(['THINK', 'THINKING', 'REASONING', 'TIP']);

/** 思考/推理路径：例如 response/thinking_content。 */
function isReasoningPath(path: unknown): boolean {
  return typeof path === 'string' && /think|reason/i.test(path);
}

/** 正文路径：response/content、response/fragments 等；状态事件（response/status）不在其中。 */
function isContentPath(path: unknown): boolean {
  return typeof path === 'string'
    && (path === 'content' || path.includes('/content') || path.endsWith('/fragments'));
}

export function extractTextFromParsed(parsed: any): string | null {
  if (!parsed || typeof parsed !== 'object') return null;

  // BATCH format: {"o":"BATCH", "v":[...]}
  if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
    for (const item of parsed.v) {
      const text = extractTextFromParsed(item);
      if (text) return text;
    }
    return null;
  }

  // 思考内容不进入 fullText：否则模型「想」过一遍的工具标记会被当成真实调用执行。
  if (isReasoningPath(parsed.p)) return null;

  if (typeof parsed.v === 'string') {
    // 无路径（早期格式）视为正文；有路径时必须命中正文路径，排除 response/status 等状态事件。
    if (parsed.p === undefined || isContentPath(parsed.p)) return parsed.v;
    return null;
  }

  // Fragment creation: {"p":"response/fragments","o":"APPEND","v":[{content:"text",...}]}
  // 只接受追加语义：REPLACE/SET 类快照会整段重复累计，让 fullText 失真。
  if (Array.isArray(parsed.v) && isContentPath(parsed.p) && parsed.o === 'APPEND') {
    const texts: string[] = [];
    for (const frag of parsed.v) {
      if (!frag || typeof frag !== 'object') continue;
      const type = typeof frag.type === 'string' ? frag.type.toUpperCase() : '';
      if (NON_CONTENT_FRAGMENT_TYPES.has(type)) continue;
      if (typeof frag.content === 'string') texts.push(frag.content);
    }
    return texts.length > 0 ? texts.join('\n') : null;
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
