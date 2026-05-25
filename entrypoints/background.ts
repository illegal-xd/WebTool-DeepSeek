import {
  getAllMemories,
  getMemoryById,
  saveMemory,
  updateMemory,
  deleteMemory,
  touchMemories,
  replaceAllMemories,
  archiveStaleMemories,
} from '../core/memory/store';
import { getAllSkills, saveSkill, deleteSkill, replaceAllCustomSkills, touchSkill } from '../core/skill/registry';
import {
  getAllPresets,
  savePreset,
  deletePreset,
  getActivePreset,
  setActivePresetId,
  replaceAllPresets,
  touchPreset,
} from '../core/preset/store';
import { getModelType, setModelType } from '../core/model/store';
import { getBackgroundConfig, saveBackgroundConfig, clearBackgroundConfig } from '../core/background/store';
import { getSyncConfig, saveSyncConfig } from '../core/sync/config';
import { webdavTest, webdavMkcol, webdavGet, webdavPut } from '../core/sync/webdav-client';
import { mergeMemories, mergeSkills, mergePresets } from '../core/sync/merge';
import {
  createMcpServer,
  deleteMcpServer,
  getAllMcpServers,
  getMcpServerById,
  getMcpToolCache,
  updateMcpServer,
} from '../core/mcp/store';
import { refreshMcpServerDiscovery } from '../core/mcp/discovery';
import { getMcpOriginPattern, requestMcpServerOriginPermission } from '../core/mcp/transports';
import { clearToolCallHistory, getToolCallHistory } from '../core/tool/history';
import { isMemoryToolName } from '../core/tool/memory';
import { executeRuntimeToolCall, getRuntimeToolDescriptors, refreshRuntimeToolDescriptors } from '../core/tool/runtime';
import {
  assignSessionsToCategory,
  attachCategoryIds,
  deleteConversationCategory,
  getConversationCategories,
  saveConversationCategory,
  unassignSessionsFromCategory,
} from '../core/conversation/store';
import { getMemoryConfig, saveMemoryConfig, type MemoryConfig } from '../core/memory/config';
import type { BackgroundConfig, ConversationCategory, ConversationMessage, ConversationSession, McpServerCreateInput, McpServerUpdateInput, Memory, ModelType, NewMemory, Skill, SyncConfig, SystemPromptPreset, ToolCall } from '../core/types';

const NEW_CHAT_URL = 'https://chat.deepseek.com/a/chat';
const CONVERSATION_SESSION_CACHE_KEY = 'webtool_deepseek_conversation_session_cache';

type ConversationSessionCache = {
  date: string;
  sessions: ConversationSession[];
  updatedAt: number;
};

export default defineBackground(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});

  archiveStaleMemories().catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  });
});

async function handleMessage(
  message: { type: string; payload?: unknown },
  sender: chrome.runtime.MessageSender,
) {
  switch (message.type) {
    case 'GET_MEMORIES':
      return getAllMemories();

    case 'GET_MEMORY_BY_ID': {
      const { id: memId } = message.payload as { id: number };
      return getMemoryById(memId) ?? null;
    }

    case 'SAVE_MEMORY': {
      const id = await saveMemory(message.payload as NewMemory);
      await broadcastStateUpdate(sender.tab?.id);
      return { id };
    }

    case 'UPDATE_MEMORY': {
      await updateMemory(message.payload as Memory);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'DELETE_MEMORY': {
      const { id } = message.payload as { id: number };
      await deleteMemory(id);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'TOUCH_MEMORIES': {
      const { ids } = message.payload as { ids: number[] };
      await touchMemories(ids);
      return { ok: true };
    }

    case 'TOUCH_USAGE': {
      const target = message.payload as
        | { kind: 'memory'; id: number }
        | { kind: 'skill'; name: string }
        | { kind: 'preset'; id: string };
      if (target.kind === 'memory') {
        await touchMemories([target.id]);
      } else if (target.kind === 'skill') {
        await touchSkill(target.name);
        await broadcastStateUpdate(sender.tab?.id);
      } else if (target.kind === 'preset') {
        await touchPreset(target.id);
        await broadcastStateUpdate(sender.tab?.id);
      }
      return { ok: true };
    }

    case 'GET_SKILLS':
      return getAllSkills();

    case 'SAVE_SKILL': {
      await saveSkill(message.payload as Skill);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'DELETE_SKILL': {
      const { name } = message.payload as { name: string };
      await deleteSkill(name);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_PRESETS':
      return getAllPresets();

    case 'SAVE_PRESET': {
      await savePreset(message.payload as SystemPromptPreset);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'DELETE_PRESET': {
      const { id: presetId } = message.payload as { id: string };
      await deletePreset(presetId);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'SET_ACTIVE_PRESET': {
      const { id: activeId } = message.payload as { id: string | null };
      await setActivePresetId(activeId);
      if (activeId) {
        await touchPreset(activeId);
      }
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_ACTIVE_PRESET':
      return getActivePreset();

    case 'GET_MCP_SERVERS': {
      const options = message.payload as { includeSecrets?: boolean } | undefined;
      return getAllMcpServers({ includeSecrets: options?.includeSecrets === true });
    }

    case 'GET_MCP_SERVER': {
      const { id } = message.payload as { id: string };
      return getMcpServerById(id);
    }

    case 'CREATE_MCP_SERVER': {
      const server = await createMcpServer(message.payload as McpServerCreateInput);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return server;
    }

    case 'UPDATE_MCP_SERVER': {
      const { id, patch } = message.payload as { id: string; patch: McpServerUpdateInput };
      const server = await updateMcpServer(id, patch);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return server;
    }

    case 'DELETE_MCP_SERVER': {
      const { id } = message.payload as { id: string };
      await deleteMcpServer(id);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_MCP_TOOL_CACHE': {
      const { serverId } = message.payload as { serverId: string };
      return getMcpToolCache(serverId);
    }

    case 'REFRESH_MCP_SERVER_TOOLS': {
      const { serverId } = message.payload as { serverId: string };
      const cache = await refreshMcpServerDiscovery(serverId);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return cache;
    }

    case 'REQUEST_MCP_SERVER_PERMISSION': {
      const { serverId } = message.payload as { serverId: string };
      const server = await getMcpServerById(serverId);
      if (!server) return { ok: false, error: 'mcp_server_not_found' };
      if (server.transport.kind === 'native_messaging') return { ok: true, origin: null };
      try {
        const origin = getMcpOriginPattern(server);
        const ok = await requestMcpServerOriginPermission(server);
        return { ok, origin };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'TEST_MCP_SERVER_CONNECTION': {
      const { serverId } = message.payload as { serverId: string };
      const cache = await refreshMcpServerDiscovery(serverId);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return { ok: cache.health.status === 'ready', cache, health: cache.health };
    }

    case 'GET_TOOL_DESCRIPTORS':
      return getRuntimeToolDescriptors();

    case 'REFRESH_TOOL_DESCRIPTORS': {
      const tools = await refreshRuntimeToolDescriptors();
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      await broadcastMcpServersUpdate(sender.tab?.id);
      return tools;
    }

    case 'EXECUTE_TOOL_CALL': {
      const call = message.payload as ToolCall;
      const result = await executeRuntimeToolCall(call, 'manual_chat');
      if (isMemoryToolName(call.name)) {
        await broadcastStateUpdate(sender.tab?.id);
      }
      await broadcastToolCallHistoryUpdate(sender.tab?.id);
      return result;
    }

    case 'GET_TOOL_CALL_HISTORY': {
      const { limit } = (message.payload as { limit?: number } | undefined) ?? {};
      return getToolCallHistory(limit);
    }

    case 'CLEAR_TOOL_CALL_HISTORY': {
      const payload = message.payload as { serverId?: string } | undefined;
      await clearToolCallHistory(payload?.serverId);
      await broadcastToolCallHistoryUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_CONFIG':
      return { version: '0.5.3' };

    case 'GET_MEMORY_CONFIG':
      return getMemoryConfig();

    case 'SET_MEMORY_CONFIG': {
      await saveMemoryConfig(message.payload as MemoryConfig);
      await broadcastToTabs({ type: 'MEMORY_CONFIG_UPDATED', tokenBudget: (message.payload as MemoryConfig).tokenBudget }, sender.tab?.id);
      return { ok: true };
    }

    case 'GET_MODEL_TYPE':
      return getModelType();

    case 'SET_MODEL_TYPE': {
      const newModelType = message.payload as ModelType;
      const current = await getModelType();
      if (newModelType === current) return { ok: true };
      await setModelType(newModelType);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_BACKGROUND':
      return getBackgroundConfig();

    case 'SAVE_BACKGROUND': {
      const bgConfig = message.payload as BackgroundConfig;
      await saveBackgroundConfig(bgConfig);
      await broadcastBackgroundUpdate(bgConfig);
      return { ok: true };
    }

    case 'CLEAR_BACKGROUND': {
      await clearBackgroundConfig();
      await broadcastBackgroundUpdate(null);
      return { ok: true };
    }

    case 'LIST_SESSIONS': {
      const forceRefresh = (message.payload as { forceRefresh?: boolean } | undefined)?.forceRefresh === true;
      const [sessions, categories] = await Promise.all([
        getCachedConversationSessions(forceRefresh),
        getConversationCategories(),
      ]);
      return attachCategoryIds(sessions, categories);
    }

    case 'DELETE_SESSION': {
      const { id } = message.payload as { id: string };
      await sendDeepSeekTabMessage<void>({ type: 'DS_DELETE_SESSION', payload: { id } });
      await navigateDeepSeekToNewChat();
      return { ok: true };
    }

    case 'DELETE_SESSIONS': {
      const { ids } = message.payload as { ids: string[] };
      for (const id of ids) {
        await sendDeepSeekTabMessage<void>({ type: 'DS_DELETE_SESSION', payload: { id } });
      }
      await navigateDeepSeekToNewChat();
      return { ok: true };
    }

    case 'RENAME_SESSION': {
      const { id, title } = message.payload as { id: string; title: string };
      await sendDeepSeekTabMessage<void>({ type: 'DS_RENAME_SESSION', payload: { id, title } });
      return { ok: true };
    }

    case 'REFRESH_DEEPSEEK_PAGE': {
      await refreshDeepSeekTab();
      return { ok: true };
    }

    case 'GET_SESSION_HISTORY': {
      const { id } = message.payload as { id: string };
      return sendDeepSeekTabMessage<ConversationMessage[]>({ type: 'DS_GET_SESSION_HISTORY', payload: { id } });
    }

    case 'GET_CONVERSATION_CATEGORIES':
      return getConversationCategories();

    case 'SAVE_CONVERSATION_CATEGORY': {
      await saveConversationCategory(message.payload as ConversationCategory);
      return { ok: true };
    }

    case 'DELETE_CONVERSATION_CATEGORY': {
      const { id } = message.payload as { id: string };
      await deleteConversationCategory(id);
      return { ok: true };
    }

    case 'ASSIGN_SESSIONS_TO_CATEGORY': {
      const { categoryId, sessionIds } = message.payload as { categoryId: string; sessionIds: string[] };
      await assignSessionsToCategory(categoryId, sessionIds);
      return { ok: true };
    }

    case 'UNASSIGN_SESSIONS_FROM_CATEGORY': {
      const { categoryId, sessionIds } = message.payload as { categoryId: string; sessionIds: string[] };
      await unassignSessionsFromCategory(categoryId, sessionIds);
      return { ok: true };
    }

    case 'GET_SYNC_CONFIG':
      return getSyncConfig();

    case 'SAVE_SYNC_CONFIG': {
      await saveSyncConfig(message.payload as SyncConfig);
      return { ok: true };
    }

    case 'WEBDAV_TEST': {
      await webdavTest(message.payload as SyncConfig);
      return { ok: true };
    }

    case 'WEBDAV_SYNC': {
      const config = await getSyncConfig();
      if (!config) throw new Error('未配置 WebDAV');

      await webdavMkcol(config);

      const [localMemories, allSkills, localPresets] = await Promise.all([
        getAllMemories(),
        getAllSkills(),
        getAllPresets(),
      ]);
      const localSkills = allSkills.filter((s) => s.source === 'custom');

      const [remoteMemJson, remoteSkillJson, remotePresetJson] = await Promise.all([
        webdavGet(config, 'memories.json'),
        webdavGet(config, 'skills.json'),
        webdavGet(config, 'presets.json'),
      ]);

      const remoteMemories: Memory[] = remoteMemJson ? JSON.parse(remoteMemJson) : [];
      const remoteSkills: Skill[] = remoteSkillJson ? JSON.parse(remoteSkillJson) : [];
      const remotePresets: SystemPromptPreset[] = remotePresetJson ? JSON.parse(remotePresetJson) : [];

      const mergedMemories = mergeMemories(localMemories, remoteMemories);
      const mergedSkills = mergeSkills(localSkills, remoteSkills);
      const mergedPresets = mergePresets(localPresets, remotePresets);

      await Promise.all([
        replaceAllMemories(mergedMemories),
        replaceAllCustomSkills(mergedSkills),
        replaceAllPresets(mergedPresets),
      ]);

      await Promise.all([
        webdavPut(config, 'memories.json', JSON.stringify(mergedMemories)),
        webdavPut(config, 'skills.json', JSON.stringify(mergedSkills)),
        webdavPut(config, 'presets.json', JSON.stringify(mergedPresets)),
      ]);

      const now = Date.now();
      await saveSyncConfig({ ...config, lastSyncAt: now });
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true, lastSyncAt: now };
    }

    default:
      return null;
  }
}

async function sendDeepSeekTabMessage<T>(message: { type: string; payload?: unknown }): Promise<T> {
  const tabs = await chrome.tabs.query({ url: '*://chat.deepseek.com/*' });
  const target = tabs.find((tab) => tab.active && tab.id !== undefined)
    ?? tabs.find((tab) => tab.id !== undefined);
  if (!target?.id) {
    throw new Error('请先打开并登录 DeepSeek 页面');
  }

  const response = await chrome.tabs.sendMessage(target.id, message) as { ok?: boolean; data?: T; error?: string } | undefined;
  if (!response?.ok) {
    throw new Error(response?.error || 'DeepSeek 页面通信失败，请刷新页面后重试');
  }
  return response.data as T;
}

async function navigateDeepSeekToNewChat() {
  const tabs = await chrome.tabs.query({ url: '*://chat.deepseek.com/*' });
  const target = tabs.find((tab) => tab.active && tab.id !== undefined)
    ?? tabs.find((tab) => tab.id !== undefined);
  if (!target?.id) return;

  await chrome.tabs.update(target.id, { url: NEW_CHAT_URL });
}

async function refreshDeepSeekTab() {
  const tabs = await chrome.tabs.query({ url: '*://chat.deepseek.com/*' });
  const target = tabs.find((tab) => tab.active && tab.id !== undefined)
    ?? tabs.find((tab) => tab.id !== undefined);
  if (!target?.id) return;

  await chrome.tabs.reload(target.id, { bypassCache: true });
}

async function getCachedConversationSessions(forceRefresh: boolean): Promise<ConversationSession[]> {
  const today = getConversationCacheDateKey();
  const cache = await readConversationSessionCache();
  if (!forceRefresh && cache?.date === today && cache.sessions.length > 0) {
    return cache.sessions;
  }

  const sessions = await sendDeepSeekTabMessage<ConversationSession[]>({ type: 'DS_LIST_SESSIONS' });
  const nextCache: ConversationSessionCache = { date: today, sessions: sessions ?? [], updatedAt: Date.now() };
  await chrome.storage.session.set({ [CONVERSATION_SESSION_CACHE_KEY]: nextCache });
  return nextCache.sessions;
}

function getConversationCacheDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

async function readConversationSessionCache(): Promise<ConversationSessionCache | null> {
  const data = await chrome.storage.session.get(CONVERSATION_SESSION_CACHE_KEY) as Record<string, unknown>;
  const raw = data[CONVERSATION_SESSION_CACHE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<ConversationSessionCache>;
  if (typeof value.date !== 'string' || !Array.isArray(value.sessions)) return null;
  return {
    date: value.date,
    sessions: value.sessions.filter((item): item is ConversationSession => Boolean(item) && typeof item === 'object' && typeof (item as ConversationSession).id === 'string'),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  };
}

async function broadcastToTabs(payload: Record<string, unknown>, excludeTabId?: number) {
  const tabs = await chrome.tabs.query({ url: '*://chat.deepseek.com/*' });
  for (const tab of tabs) {
    if (tab.id && tab.id !== excludeTabId) {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
  }
  if (excludeTabId) {
    chrome.tabs.sendMessage(excludeTabId, payload).catch(() => {});
  }
}

async function broadcastStateUpdate(excludeTabId?: number) {
  const [memories, skills, presets, activePreset, modelType, toolDescriptors] = await Promise.all([
    getAllMemories(),
    getAllSkills(),
    getAllPresets(),
    getActivePreset(),
    getModelType(),
    getRuntimeToolDescriptors(),
  ]);
  const payload = { type: 'STATE_UPDATED', memories, skills, presets, activePreset, modelType, toolDescriptors };
  await broadcastToTabs(payload, excludeTabId);
  // Also notify extension pages (sidepanel, popup) via runtime messaging
  chrome.runtime.sendMessage(payload).catch(() => {});
}

async function broadcastBackgroundUpdate(config: BackgroundConfig | null) {
  await broadcastToTabs({ type: 'BACKGROUND_UPDATED', config });
}

async function broadcastMcpServersUpdate(excludeTabId?: number) {
  const servers = await getAllMcpServers();
  await broadcastToTabs({ type: 'MCP_SERVERS_UPDATED', servers }, excludeTabId);
}

async function broadcastToolDescriptorsUpdate(excludeTabId?: number) {
  const toolDescriptors = await getRuntimeToolDescriptors();
  await broadcastToTabs({ type: 'TOOL_DESCRIPTORS_UPDATED', toolDescriptors }, excludeTabId);
}

async function broadcastToolCallHistoryUpdate(excludeTabId?: number) {
  await broadcastToTabs({ type: 'TOOL_CALL_HISTORY_UPDATED' }, excludeTabId);
}
