import assert from 'node:assert/strict';
import { createToolMarkupStreamFilter } from '../core/interceptor/tool-stream-filter.ts';
import type { ToolDescriptor } from '../core/tool';

function createDescriptor(name: string): ToolDescriptor {
  return {
    id: `mcp:test:${name}`,
    provider: { kind: 'mcp', id: 'test', displayName: 'Test MCP', transport: 'streamable_http' },
    name,
    invocationName: name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    execution: { mode: 'auto', enabled: true, risk: 'medium' },
  };
}

function collect(chunks: string[]): string {
  const filter = createToolMarkupStreamFilter({ descriptors: [createDescriptor('memory_save')] });
  return chunks.map((chunk) => filter.push(chunk)).join('') + filter.flush();
}

assert.equal(
  collect(['<memory_save>{"content":"x"}</memory', '_save>这里开始是正常回答']),
  '这里开始是正常回答',
);

assert.equal(
  collect(['前文', '<memory', '_save>{"content":"x"}</memory_save>', '后文']),
  '前文后文',
);

console.log('ok - streaming tool markup filter survives split tags');
