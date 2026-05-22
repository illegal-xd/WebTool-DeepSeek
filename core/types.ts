export type MemoryType = 'user' | 'feedback' | 'topic' | 'reference';
export type MemoryScope = 'permanent' | 'contextual' | 'temporary';

export type ModelType = 'expert' | null;

export interface UsageStats {
  useCount: number;
  lastUsedAt: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface BackgroundConfig {
  enabled: boolean;
  type: 'upload' | 'url';
  url?: string;
  imageData?: string;
  opacity: number;
}

export interface Memory {
  id?: number;
  syncId: string;
  type: MemoryType;
  scope: MemoryScope;
  name: string;
  content: string;
  description: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  expiresAt?: number;
}

export interface SyncConfig {
  url: string;
  username: string;
  password: string;
  remotePath: string;
  lastSyncAt: number | null;
}

export type SkillSource = 'builtin' | 'custom';

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  source: SkillSource;
  memoryEnabled: boolean;
  memoryIds?: number[];
  usage?: UsageStats;
  metadata?: Record<string, string>;
}

export interface SkillInvocation {
  skillName: string;
  args: string;
  rawInput: string;
}

export interface ToolCall {
  name: string;
  payload: Record<string, unknown>;
  raw: string;
}

export interface ToolCardResult {
  ok: boolean;
  summary: string;
  detail?: string;
}

export interface ToolExecutionRecord {
  name: string;
  result: ToolCardResult;
}

export interface ToolCallRestoreRecord {
  id: string;
  calls: ToolCall[];
  executions: ToolExecutionRecord[];
  content: string;
  source: string;
  url: string;
  timestamp: number;
}

export type NewMemory = {
  type: MemoryType;
  name: string;
  content: string;
  description: string;
  tags: string[];
  pinned: boolean;
  syncId?: string;
  scope?: MemoryScope;
  expiresAt?: number;
};

export interface SystemPromptPreset {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  memoryEnabled?: boolean;
  memoryIds?: number[];
  usage?: UsageStats;
}

export interface ConversationSession {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messageCount?: number;
  categoryIds?: string[];
  modelType?: string;
  pinned?: boolean;
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  reasoning?: string;
  toolCalls?: ToolCall[];
}

export interface ConversationCategory {
  id: string;
  name: string;
  color: string;
  createdAt: number;
  sessionIds: string[];
}

export type ConversationExportFormat = 'json' | 'md' | 'txt';

export interface DeepSeekRequest {
  chat_session_id: string;
  model_type: string;
  parent_message_id: string | null;
  preempt: boolean;
  prompt: string;
  ref_file_ids: string[];
  search_enabled: boolean;
  thinking_enabled: boolean;
}

export interface SSEEvent {
  id?: string;
  type: string;
  data: string;
}

export type MessageAction =
  | { type: 'GET_MEMORIES' }
  | { type: 'GET_MEMORY_BY_ID'; payload: { id: number } }
  | { type: 'GET_SKILLS' }
  | { type: 'SAVE_MEMORY'; payload: NewMemory }
  | { type: 'DELETE_MEMORY'; payload: { id: number } }
  | { type: 'UPDATE_MEMORY'; payload: Memory }
  | { type: 'SAVE_SKILL'; payload: Skill }
  | { type: 'DELETE_SKILL'; payload: { name: string } }
  | { type: 'GET_PRESETS' }
  | { type: 'SAVE_PRESET'; payload: SystemPromptPreset }
  | { type: 'DELETE_PRESET'; payload: { id: string } }
  | { type: 'SET_ACTIVE_PRESET'; payload: { id: string | null } }
  | { type: 'GET_ACTIVE_PRESET' }
  | { type: 'GET_CONFIG' }
  | { type: 'GET_MODEL_TYPE' }
  | { type: 'SET_MODEL_TYPE'; payload: ModelType }
  | { type: 'TOUCH_USAGE'; payload: { kind: 'memory'; id: number } | { kind: 'skill'; name: string } | { kind: 'preset'; id: string } }
  | { type: 'TOOL_CALL_EXECUTED'; payload: ToolCall }
  | { type: 'MEMORIES_UPDATED' }
  | { type: 'WEBDAV_TEST'; payload: Omit<SyncConfig, 'lastSyncAt'> }
  | { type: 'WEBDAV_SYNC' }
  | { type: 'GET_SYNC_CONFIG' }
  | { type: 'SAVE_SYNC_CONFIG'; payload: SyncConfig }
  | { type: 'GET_BACKGROUND' }
  | { type: 'SAVE_BACKGROUND'; payload: BackgroundConfig }
  | { type: 'CLEAR_BACKGROUND' }
  | { type: 'LIST_SESSIONS' }
  | { type: 'DELETE_SESSION'; payload: { id: string } }
  | { type: 'DELETE_SESSIONS'; payload: { ids: string[] } }
  | { type: 'RENAME_SESSION'; payload: { id: string; title: string } }
  | { type: 'REFRESH_DEEPSEEK_PAGE' }
  | { type: 'GET_SESSION_HISTORY'; payload: { id: string } }
  | { type: 'GET_CONVERSATION_CATEGORIES' }
  | { type: 'SAVE_CONVERSATION_CATEGORY'; payload: ConversationCategory }
  | { type: 'DELETE_CONVERSATION_CATEGORY'; payload: { id: string } }
  | { type: 'ASSIGN_SESSIONS_TO_CATEGORY'; payload: { categoryId: string; sessionIds: string[] } }
  | { type: 'UNASSIGN_SESSIONS_FROM_CATEGORY'; payload: { categoryId: string; sessionIds: string[] } };

export interface PromptConfig {
  memoryTokenBudget: number;
  systemTemplate: string;
}
