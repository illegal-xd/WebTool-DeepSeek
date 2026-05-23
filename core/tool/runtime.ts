import { deleteMemory, getMemoryById, saveMemory, updateMemory } from '../memory/store';
import { executeMcpToolCall, getMcpToolDescriptors, refreshMcpServerDiscovery } from '../mcp/discovery';
import { getAllMcpServers } from '../mcp/store';
import type { Memory, NewMemory } from '../types';
import { appendToolCallHistory } from './history';
import { MEMORY_TOOL_DESCRIPTORS, executeMemoryToolCall, isMemoryToolName, type MemoryToolRuntime } from './memory';
import type { ToolCall, ToolDescriptor, ToolExecutionTrigger, ToolResult } from './types';

const memoryRuntime: MemoryToolRuntime = {
  async saveMemory(input: NewMemory) {
    const id = await saveMemory(input);
    return { id };
  },
  async getMemoryById(id: number) {
    return (await getMemoryById(id)) ?? null;
  },
  async updateMemory(memory: Memory) {
    await updateMemory(memory);
  },
  async deleteMemory(id: number) {
    await deleteMemory(id);
  },
};

export async function getRuntimeToolDescriptors(): Promise<ToolDescriptor[]> {
  return [...MEMORY_TOOL_DESCRIPTORS, ...await getMcpToolDescriptors()];
}

export async function refreshRuntimeToolDescriptors(): Promise<ToolDescriptor[]> {
  const servers = await getAllMcpServers({ includeSecrets: false });
  await Promise.all(servers.filter((server) => server.enabled).map((server) => refreshMcpServerDiscovery(server.id)));
  return getRuntimeToolDescriptors();
}

export async function executeRuntimeToolCall(call: ToolCall, source: ToolExecutionTrigger): Promise<ToolResult> {
  const result = await executeToolCallWithoutHistory(call);
  await appendToolCallHistory(call, result, source);
  return result;
}

async function executeToolCallWithoutHistory(call: ToolCall): Promise<ToolResult> {
  if (isMemoryToolName(call.name)) return executeMemoryToolCall(memoryRuntime, call);
  if (call.provider?.kind === 'mcp' || call.descriptorId?.startsWith('mcp:')) return executeMcpToolCall(call);
  return { ok: false, summary: '未知工具', detail: `Unsupported tool: ${call.name}`, name: call.name, provider: call.provider, descriptorId: call.descriptorId, error: { code: 'tool_unsupported', message: `Unsupported tool: ${call.name}`, retryable: false } };
}
