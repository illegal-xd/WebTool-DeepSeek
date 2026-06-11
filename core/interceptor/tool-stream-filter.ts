import {
  DEFAULT_RECOGNIZED_TOOL_TAGS,
  createToolInvocationCatalog,
  getToolCloseTag,
  getToolOpenTag,
  type ToolDescriptor,
} from '../tool';

interface ToolMarkupStreamFilterOptions {
  descriptors?: readonly ToolDescriptor[];
  recognizedTags?: readonly string[];
}

export interface ToolMarkupStreamFilter {
  push(text: string): string;
  flush(): string;
  isInsideToolBlock(): boolean;
}

interface ToolTagMatch {
  index: number;
  name: string;
  tag: string;
}

export function createToolMarkupStreamFilter(options?: ToolMarkupStreamFilterOptions): ToolMarkupStreamFilter {
  const catalog = createToolInvocationCatalog(options?.descriptors ?? [], options?.recognizedTags ?? DEFAULT_RECOGNIZED_TOOL_TAGS);
  const names = catalog.invocationNames.filter(Boolean);
  const openTags = names.map((name) => getToolOpenTag(name));
  const closeTags = names.map((name) => getToolCloseTag(name));

  let buffer = '';
  let insideToolBlock = false;
  let activeToolName: string | null = null;

  const drain = (final: boolean): string => {
    if (names.length === 0) {
      const text = buffer;
      buffer = '';
      return text;
    }

    let output = '';

    while (buffer.length > 0) {
      if (insideToolBlock) {
        const closeMatch = activeToolName ? findCloseTag(buffer, activeToolName) : findFirstCloseTag(buffer, names);
        if (!closeMatch) {
          if (final) {
            buffer = '';
          } else {
            buffer = keepPotentialTagPrefix(buffer, activeToolName ? [getToolCloseTag(activeToolName)] : closeTags);
          }
          return output;
        }

        buffer = buffer.slice(closeMatch.index + closeMatch.tag.length);
        insideToolBlock = false;
        activeToolName = null;
        continue;
      }

      const openMatch = findFirstOpenTag(buffer, names);
      if (!openMatch) {
        if (final) {
          output += buffer;
          buffer = '';
          return output;
        }
        const pending = keepPotentialTagPrefix(buffer, openTags);
        output += buffer.slice(0, buffer.length - pending.length);
        buffer = pending;
        return output;
      }

      output += buffer.slice(0, openMatch.index);
      buffer = buffer.slice(openMatch.index + openMatch.tag.length);
      insideToolBlock = true;
      activeToolName = openMatch.name;
    }

    return output;
  };

  return {
    push(text: string) {
      buffer += text;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
    isInsideToolBlock() {
      return insideToolBlock;
    },
  };
}

function keepPotentialTagPrefix(text: string, tags: readonly string[]): string {
  let best = '';
  for (const tag of tags) {
    const max = Math.min(text.length, tag.length - 1);
    for (let length = max; length > best.length; length--) {
      const suffix = text.slice(text.length - length);
      if (tag.startsWith(suffix)) {
        best = suffix;
        break;
      }
    }
  }
  return best;
}

function findFirstOpenTag(text: string, names: readonly string[]): ToolTagMatch | null {
  let best: ToolTagMatch | null = null;
  for (const name of names) {
    const tag = getToolOpenTag(name);
    const index = text.indexOf(tag);
    if (index !== -1 && (!best || index < best.index)) best = { index, name, tag };
  }
  return best;
}

function findCloseTag(text: string, name: string): ToolTagMatch | null {
  const tag = getToolCloseTag(name);
  const index = text.indexOf(tag);
  return index === -1 ? null : { index, name, tag };
}

function findFirstCloseTag(text: string, names: readonly string[]): ToolTagMatch | null {
  let best: ToolTagMatch | null = null;
  for (const name of names) {
    const match = findCloseTag(text, name);
    if (match && (!best || match.index < best.index)) best = match;
  }
  return best;
}
