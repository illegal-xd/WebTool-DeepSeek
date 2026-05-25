import { useEffect, useRef, useState } from 'react';
import type { BackgroundConfig, McpServerConfig, Memory, SyncConfig, Skill, SystemPromptPreset } from '../../../core/types';
import { useTheme } from '../../../hooks/useTheme';
import type { ThemePreference } from '../../../lib/ThemeContext';
import { SVG_PATHS } from '../constants';

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  url: '',
  username: '',
  password: '',
  remotePath: 'DeepSeekPP',
  lastSyncAt: null,
};

type SyncStatus = 'idle' | 'testing' | 'syncing' | 'success' | 'error';
type BackupDataType = 'memories' | 'skills' | 'presets' | 'mcpServers';

const BACKUP_OPTIONS: { key: BackupDataType; label: string; getCount: (counts: { memories: number; skills: number; presets: number; mcpServers: number }) => number }[] = [
  { key: 'memories', label: '记忆', getCount: (counts) => counts.memories },
  { key: 'skills', label: 'Skill', getCount: (counts) => counts.skills },
  { key: 'presets', label: '预设', getCount: (counts) => counts.presets },
  { key: 'mcpServers', label: 'MCP', getCount: (counts) => counts.mcpServers },
];

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: '浅色模式' },
  { value: 'dark', label: '暗黑模式' },
  { value: 'system', label: '系统自动' },
];

type BackupSelection = Record<BackupDataType, boolean>;

interface BackupPayload {
  type: 'webtool-deepseek_backup';
  version: string;
  exportedAt: number;
  includes: BackupSelection;
  memories?: Memory[];
  skills?: Skill[];
  presets?: SystemPromptPreset[];
  mcpServers?: McpServerConfig[];
}

interface ParsedBackupData {
  memories: Memory[];
  skills: Skill[];
  presets: SystemPromptPreset[];
  mcpServers: McpServerConfig[];
}

const DEFAULT_BACKUP_SELECTION: BackupSelection = {
  memories: true,
  skills: true,
  presets: true,
  mcpServers: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function arrayFromRecord<T>(record: Record<string, unknown>, key: string): T[] {
  const value = record[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseBackupData(parsed: unknown): ParsedBackupData {
  if (Array.isArray(parsed)) {
    return { memories: parsed as Memory[], skills: [], presets: [], mcpServers: [] };
  }

  if (isRecord(parsed) && parsed.type === 'webtool-deepseek_backup') {
    return {
      memories: arrayFromRecord<Memory>(parsed, 'memories'),
      skills: arrayFromRecord<Skill>(parsed, 'skills'),
      presets: arrayFromRecord<SystemPromptPreset>(parsed, 'presets'),
      mcpServers: arrayFromRecord<McpServerConfig>(parsed, 'mcpServers'),
    };
  }

  throw new Error('未知的 JSON 备份格式');
}

function mergeMemoryForImport(imported: Memory, existing: Memory): Memory {
  return {
    ...existing,
    ...imported,
    id: existing.id,
    syncId: existing.syncId,
    accessCount: Math.max(existing.accessCount ?? 0, imported.accessCount ?? 0),
    lastAccessedAt: Math.max(existing.lastAccessedAt ?? 0, imported.lastAccessedAt ?? 0),
  };
}

export default function SettingsPage() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [memoryCount, setMemoryCount] = useState(0);
  const [customSkillCount, setCustomSkillCount] = useState(0);
  const [presetCount, setPresetCount] = useState(0);
  const [mcpServerCount, setMcpServerCount] = useState(0);
  const [version, setVersion] = useState('');
  const [syncConfig, setSyncConfig] = useState<SyncConfig>(DEFAULT_SYNC_CONFIG);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncMessage, setSyncMessage] = useState('');
  const [backupSelection, setBackupSelection] = useState<BackupSelection>(DEFAULT_BACKUP_SELECTION);
  const [expertMode, setExpertMode] = useState(false);
  const [memoryTokenBudget, setMemoryTokenBudget] = useState(3000);
  const [bgEnabled, setBgEnabled] = useState(false);
  const [bgType, setBgType] = useState<'upload' | 'url'>('upload');
  const [bgUrl, setBgUrl] = useState('');
  const [bgImageData, setBgImageData] = useState('');
  const [bgOpacity, setBgOpacity] = useState(0.3);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const opacitySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bgPreview = bgType === 'url' ? bgUrl : bgImageData;
  const hasBackupSelection = Object.values(backupSelection).some(Boolean);

  const loadCounts = async () => {
    const memories: Memory[] = await chrome.runtime.sendMessage({ type: 'GET_MEMORIES' });
    setMemoryCount(memories?.length ?? 0);

    const skills: Skill[] = await chrome.runtime.sendMessage({ type: 'GET_SKILLS' });
    const custom = skills?.filter(s => s.source === 'custom') ?? [];
    setCustomSkillCount(custom.length);

    const presets: SystemPromptPreset[] = await chrome.runtime.sendMessage({ type: 'GET_PRESETS' });
    setPresetCount(presets?.length ?? 0);

    const mcpServers: McpServerConfig[] = await chrome.runtime.sendMessage({ type: 'GET_MCP_SERVERS' });
    setMcpServerCount(mcpServers?.length ?? 0);
  };

  useEffect(() => {
    loadCounts();
    chrome.runtime.sendMessage({ type: 'GET_CONFIG' }).then((cfg: { version: string }) => {
      setVersion(cfg?.version ?? '');
    });
    chrome.runtime.sendMessage({ type: 'GET_SYNC_CONFIG' }).then((cfg: SyncConfig | null) => {
      if (cfg) setSyncConfig(cfg);
    });
    chrome.runtime.sendMessage({ type: 'GET_MODEL_TYPE' }).then((val: string | null) => {
      setExpertMode(val === 'expert');
    });
    chrome.runtime.sendMessage({ type: 'GET_BACKGROUND' }).then((cfg: BackgroundConfig | null) => {
      if (!cfg) return;
      setBgEnabled(cfg.enabled);
      setBgType(cfg.type);
      setBgUrl(cfg.url ?? '');
      setBgImageData(cfg.imageData ?? '');
      setBgOpacity(cfg.opacity);
    });
    chrome.runtime.sendMessage({ type: 'GET_MEMORY_CONFIG' }).then((cfg: { tokenBudget: number } | null) => {
      if (cfg) setMemoryTokenBudget(cfg.tokenBudget);
    });
  }, []);

  const handleExpertToggle = async (enabled: boolean) => {
    setExpertMode(enabled);
    await chrome.runtime.sendMessage({
      type: 'SET_MODEL_TYPE',
      payload: enabled ? 'expert' : null,
    });
  };

  const handleMemoryTokenBudgetChange = async (val: number) => {
    const clamped = Math.max(500, Math.min(10000, val));
    setMemoryTokenBudget(clamped);
    await chrome.runtime.sendMessage({ type: 'SET_MEMORY_CONFIG', payload: { tokenBudget: clamped } });
  };

  const saveBgConfig = async (patch: Partial<BackgroundConfig>) => {
    const config: BackgroundConfig = {
      enabled: patch.enabled ?? bgEnabled,
      type: patch.type ?? bgType,
      url: patch.url ?? bgUrl,
      imageData: patch.imageData ?? bgImageData,
      opacity: patch.opacity ?? bgOpacity,
    };
    await chrome.runtime.sendMessage({ type: 'SAVE_BACKGROUND', payload: config });
  };

  const handleBgToggle = async (enabled: boolean) => {
    setBgEnabled(enabled);
    await saveBgConfig({ enabled });
  };

  const resizeImage = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const MAX = 1920;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = Math.min(MAX / width, MAX / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Failed to load image'));
      };
      img.src = objectUrl;
    });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    let data: string;
    try {
      data = await resizeImage(file);
    } catch {
      return;
    }
    setBgType('upload');
    setBgImageData(data);
    setBgEnabled(true);
    await saveBgConfig({ enabled: true, type: 'upload', imageData: data, url: '' });
    e.target.value = '';
  };

  const handleUrlConfirm = async () => {
    if (!bgUrl.trim()) return;
    setBgType('url');
    setBgImageData('');
    setBgEnabled(true);
    await saveBgConfig({ enabled: true, type: 'url', url: bgUrl, imageData: '' });
  };

  const handleOpacityChange = (val: number) => {
    setBgOpacity(val);
    if (opacitySaveTimer.current) clearTimeout(opacitySaveTimer.current);
    opacitySaveTimer.current = setTimeout(() => saveBgConfig({ opacity: val }), 200);
  };

  const handleClearBg = async () => {
    setBgEnabled(false);
    setBgType('upload');
    setBgUrl('');
    setBgImageData('');
    setBgOpacity(0.3);
    await chrome.runtime.sendMessage({ type: 'CLEAR_BACKGROUND' });
  };

  const updateField = (field: keyof SyncConfig, value: string) => {
    setSyncConfig((prev) => ({ ...prev, [field]: value }));
  };

  const requestPermission = async (url: string): Promise<boolean> => {
    try {
      const origin = new URL(url).origin + '/*';
      return await chrome.permissions.request({ origins: [origin] });
    } catch {
      return false;
    }
  };

  const runSyncAction = async (
    status: 'testing' | 'syncing',
    action: () => Promise<void>,
  ) => {
    if (!syncConfig.url) return;
    setSyncStatus(status);
    setSyncMessage('');

    const granted = await requestPermission(syncConfig.url);
    if (!granted) {
      setSyncStatus('error');
      setSyncMessage('需要访问权限才能连接 WebDAV 服务器');
      return;
    }

    try {
      await chrome.runtime.sendMessage({ type: 'SAVE_SYNC_CONFIG', payload: syncConfig });
      await action();
    } catch (e) {
      setSyncStatus('error');
      setSyncMessage((e as Error).message || '操作失败');
    }
  };

  const handleTest = () =>
    runSyncAction('testing', async () => {
      await chrome.runtime.sendMessage({ type: 'WEBDAV_TEST', payload: syncConfig });
      setSyncStatus('success');
      setSyncMessage('连接成功');
    });

  const handleSync = () =>
    runSyncAction('syncing', async () => {
      const result = await chrome.runtime.sendMessage({ type: 'WEBDAV_SYNC' });
      if (result?.ok) {
        setSyncConfig((prev) => ({ ...prev, lastSyncAt: result.lastSyncAt }));
        setSyncStatus('success');
        setSyncMessage('同步完成');
        loadCounts();
      } else {
        throw new Error(result?.error || '同步失败');
      }
    });

  const toggleBackupSelection = (key: BackupDataType) => {
    setBackupSelection((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleExport = async () => {
    if (!hasBackupSelection) {
      alert('请至少选择一种要导出的数据');
      return;
    }

    const exportData: BackupPayload = {
      type: 'webtool-deepseek_backup',
      version: '0.5.4',
      exportedAt: Date.now(),
      includes: backupSelection,
    };

    if (backupSelection.memories) {
      exportData.memories = await chrome.runtime.sendMessage({ type: 'GET_MEMORIES' });
    }
    if (backupSelection.skills) {
      const skills: Skill[] = await chrome.runtime.sendMessage({ type: 'GET_SKILLS' });
      exportData.skills = skills?.filter(s => s.source === 'custom') ?? [];
    }
    if (backupSelection.presets) {
      exportData.presets = await chrome.runtime.sendMessage({ type: 'GET_PRESETS' });
    }
    if (backupSelection.mcpServers) {
      exportData.mcpServers = await chrome.runtime.sendMessage({ type: 'GET_MCP_SERVERS', payload: { includeSecrets: true } });
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `WebTool-DeepSeek-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const parsed = parseBackupData(JSON.parse(text));

        const existingMemories: Memory[] = await chrome.runtime.sendMessage({ type: 'GET_MEMORIES' });
        const existingBySyncId = new Map(
          existingMemories
            .filter((mem) => mem.syncId)
            .map((mem) => [mem.syncId, mem]),
        );

        for (const mem of parsed.memories) {
          const existing = mem.syncId ? existingBySyncId.get(mem.syncId) : undefined;
          if (existing) {
            await chrome.runtime.sendMessage({ type: 'UPDATE_MEMORY', payload: mergeMemoryForImport(mem, existing) });
          } else {
            const { id, createdAt, updatedAt, accessCount, lastAccessedAt, ...rest } = mem;
            await chrome.runtime.sendMessage({ type: 'SAVE_MEMORY', payload: rest });
          }
        }

        for (const skill of parsed.skills) {
          await chrome.runtime.sendMessage({ type: 'SAVE_SKILL', payload: { ...skill, source: 'custom' } });
        }

        for (const preset of parsed.presets) {
          await chrome.runtime.sendMessage({ type: 'SAVE_PRESET', payload: preset });
        }

        const existingMcpServers: McpServerConfig[] = await chrome.runtime.sendMessage({ type: 'GET_MCP_SERVERS', payload: { includeSecrets: true } });
        const existingMcpById = new Map((existingMcpServers ?? []).map((server) => [server.id, server]));
        for (const server of parsed.mcpServers) {
          if (existingMcpById.has(server.id)) {
            await chrome.runtime.sendMessage({ type: 'UPDATE_MCP_SERVER', payload: { id: server.id, patch: server } });
          } else {
            await chrome.runtime.sendMessage({ type: 'CREATE_MCP_SERVER', payload: server });
          }
        }

        alert(`导入成功：记忆 ${parsed.memories.length} 条，Skill ${parsed.skills.length} 个，预设 ${parsed.presets.length} 个，MCP ${parsed.mcpServers.length} 个`);
        loadCounts();
      } catch (e) {
        alert('导入失败: ' + (e as Error).message);
      }
    };
    input.click();
  };

  const handleClearAll = async () => {
    if (!confirm('确定要清除所有数据（记忆、自定义 Skill、系统预设）吗？此操作不可撤销。')) return;
    
    // Clear memories
    const memories: Memory[] = await chrome.runtime.sendMessage({ type: 'GET_MEMORIES' });
    for (const mem of memories) {
      if (mem.id !== undefined) {
        await chrome.runtime.sendMessage({ type: 'DELETE_MEMORY', payload: { id: mem.id } });
      }
    }

    // Clear custom skills
    const skills: Skill[] = await chrome.runtime.sendMessage({ type: 'GET_SKILLS' });
    const custom = skills.filter((s) => s.source === 'custom');
    for (const s of custom) {
      await chrome.runtime.sendMessage({ type: 'DELETE_SKILL', payload: { name: s.name } });
    }

    // Clear presets
    const presets: SystemPromptPreset[] = await chrome.runtime.sendMessage({ type: 'GET_PRESETS' });
    for (const p of presets) {
      await chrome.runtime.sendMessage({ type: 'DELETE_PRESET', payload: { id: p.id } });
    }

    loadCounts();
    alert('所有数据已清除');
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return '从未同步';
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const inputClass =
    'w-full px-3 py-2 text-xs rounded-lg border outline-none transition-colors focus:border-[var(--ds-blue)]';

  const inputStyle = {
    background: 'var(--ds-bg)',
    borderColor: 'var(--ds-border)',
    color: 'var(--ds-text)',
  };

  return (
    <div className="p-4 space-y-5">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
              主题设置
            </h2>
            <p className="text-[11px] mt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
              当前实际显示为{resolvedTheme === 'dark' ? '暗黑模式' : '浅色模式'}
            </p>
          </div>
        </div>
        <div className="ds-surface-panel rounded-xl p-2 space-y-3">
          <div className="grid grid-cols-3 gap-1.5">
            {THEME_OPTIONS.map((option) => {
              const active = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setTheme(option.value)}
                  className="rounded-lg border px-2 py-2 text-[11px] font-medium transition-all duration-150"
                  style={{
                    borderColor: active ? 'var(--ds-accent-primary)' : 'var(--ds-border)',
                    background: active ? 'var(--ds-accent-muted)' : 'var(--ds-bg)',
                    color: active ? 'var(--ds-accent-primary)' : 'var(--ds-text-secondary)',
                    boxShadow: active ? 'var(--ds-blue-shadow)' : 'none',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="border-t pt-3 space-y-3" style={{ borderColor: 'var(--ds-border)' }}>
            <div className="flex justify-between items-center px-2">
              <div>
                <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
                  自定义背景
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--ds-text-tertiary)' }}>
                  为 DeepSeek 页面设置背景图片
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleBgToggle(!bgEnabled)}
                aria-pressed={bgEnabled}
                aria-label="切换自定义背景"
                className="relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200"
                style={{
                  background: bgEnabled ? 'var(--ds-blue)' : 'var(--ds-border)',
                }}
              >
                <span
                  className="absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"
                  style={{
                    transform: bgEnabled ? 'translateX(18px)' : 'translateX(0)',
                  }}
                />
              </button>
            </div>

            {bgEnabled && (
              <div className="space-y-3 px-2">
                <div className="flex gap-2">
                  <input
                    id="custom-background-file"
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="ds-btn-secondary flex-1 py-2 text-[11px] font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.upload} />
                    </svg>
                    上传图片
                  </button>
                </div>

                <div className="flex gap-2">
                  <input
                    id="custom-background-url"
                    type="url"
                    placeholder="粘贴图片 URL"
                    value={bgUrl}
                    onChange={(e) => setBgUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleUrlConfirm()}
                    className={inputClass}
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    onClick={handleUrlConfirm}
                    disabled={!bgUrl.trim()}
                    className="ds-btn-secondary shrink-0 px-3 py-2 text-[11px] font-medium rounded-lg transition-all duration-150 disabled:opacity-40"
                  >
                    确认
                  </button>
                </div>

                {bgPreview && (
                  <div
                    className="relative rounded-lg overflow-hidden border"
                    style={{ borderColor: 'var(--ds-border)', height: '120px' }}
                  >
                    <img
                      src={bgPreview}
                      alt="背景预览"
                      className="w-full h-full object-cover"
                      onError={() => { setBgUrl(''); setBgImageData(''); }}
                    />
                    <div
                      className="absolute inset-0 flex items-center justify-center text-[10px]"
                      style={{
                        background: `rgba(255,255,255,${(1 - bgOpacity).toFixed(3)})`,
                        backdropFilter: `blur(${((1 - bgOpacity) * 8).toFixed(1)}px)`,
                        WebkitBackdropFilter: `blur(${((1 - bgOpacity) * 8).toFixed(1)}px)`,
                        color: 'var(--ds-text-secondary)',
                        pointerEvents: 'none',
                      }}
                    >
                      模拟效果预览
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <label htmlFor="custom-background-opacity" className="text-[11px]" style={{ color: 'var(--ds-text-secondary)' }}>
                      背景透明度
                    </label>
                    <span className="text-[11px] font-mono" style={{ color: 'var(--ds-text-tertiary)' }}>
                      {bgOpacity.toFixed(2)}
                    </span>
                  </div>
                  <input
                    id="custom-background-opacity"
                    type="range"
                    min="0.05"
                    max="1"
                    step="0.05"
                    value={bgOpacity}
                    onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
                    className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, var(--ds-blue) ${bgOpacity * 100}%, var(--ds-border) ${bgOpacity * 100}%)`,
                    }}
                  />
                </div>

                {bgPreview && (
                  <button
                    type="button"
                    onClick={handleClearBg}
                    className="ds-btn-danger w-full py-2 text-[11px] font-medium rounded-lg transition-all duration-150"
                  >
                    清除背景
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
          模型设置
        </h2>

        <div className="ds-surface-panel rounded-xl p-4 space-y-3">
          <div className="flex justify-between items-center">
            <div>
              <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
                Expert 模式
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--ds-text-tertiary)' }}>
                使用 DeepSeek Expert 模型进行对话
              </div>
            </div>
            <button
              onClick={() => handleExpertToggle(!expertMode)}
              className="relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200"
              style={{
                background: expertMode ? 'var(--ds-blue)' : 'var(--ds-border)',
              }}
            >
              <span
                className="absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"
                style={{
                  transform: expertMode ? 'translateX(18px)' : 'translateX(0)',
                }}
              />
            </button>
          </div>

          <div className="border-t pt-3" style={{ borderColor: 'var(--ds-border)' }}>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="memory-token-budget" className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
                注入上下文限制
              </label>
              <span className="text-[11px] font-mono tabular-nums" style={{ color: 'var(--ds-text-tertiary)' }}>
                {memoryTokenBudget}
              </span>
            </div>
            <div className="text-[11px] mb-2" style={{ color: 'var(--ds-text-tertiary)' }}>
              记忆注入的最大 Token 预算（影响注入数量），范围 500 ~ 10000
            </div>
            <div className="flex items-center gap-3">
              <input
                id="memory-token-budget"
                type="range"
                min="500"
                max="10000"
                step="100"
                value={memoryTokenBudget}
                onChange={(e) => handleMemoryTokenBudgetChange(parseInt(e.target.value))}
                className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, var(--ds-blue) ${((memoryTokenBudget - 500) / 9500) * 100}%, var(--ds-border) ${((memoryTokenBudget - 500) / 9500) * 100}%)`,
                }}
              />
              <input
                type="number"
                min="500"
                max="10000"
                step="100"
                value={memoryTokenBudget}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v)) handleMemoryTokenBudgetChange(v);
                }}
                className="w-20 px-2 py-1.5 text-xs rounded-lg border text-center tabular-nums outline-none transition-colors focus:border-[var(--ds-blue)]"
                style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)', color: 'var(--ds-text)' }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
          云同步
        </h2>

        <div className="ds-surface-panel rounded-xl p-4 space-y-3">
          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--ds-text-secondary)' }}>
              WebDAV 地址
            </label>
            <input
              type="url"
              placeholder="https://dav.example.com/dav/"
              value={syncConfig.url}
              onChange={(e) => updateField('url', e.target.value)}
              className={inputClass}
              style={inputStyle}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] mb-1" style={{ color: 'var(--ds-text-secondary)' }}>
                用户名
              </label>
              <input
                type="text"
                value={syncConfig.username}
                onChange={(e) => updateField('username', e.target.value)}
                className={inputClass}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="block text-[11px] mb-1" style={{ color: 'var(--ds-text-secondary)' }}>
                密码
              </label>
              <input
                type="password"
                value={syncConfig.password}
                onChange={(e) => updateField('password', e.target.value)}
                className={inputClass}
                style={inputStyle}
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--ds-text-secondary)' }}>
              远程路径
            </label>
            <input
              type="text"
              value={syncConfig.remotePath}
              onChange={(e) => updateField('remotePath', e.target.value)}
              className={inputClass}
              style={inputStyle}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleTest}
            disabled={!syncConfig.url || syncStatus === 'testing' || syncStatus === 'syncing'}
            className="ds-btn-secondary flex-1 py-2.5 text-xs font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {syncStatus === 'testing' ? (
              <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            测试连接
          </button>
          <button
            onClick={handleSync}
            disabled={!syncConfig.url || syncStatus === 'testing' || syncStatus === 'syncing'}
            className="ds-btn-secondary flex-1 py-2.5 text-xs font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 disabled:opacity-40"
            style={
              syncConfig.url && syncStatus !== 'testing' && syncStatus !== 'syncing'
                ? { background: 'var(--ds-blue)', color: 'var(--ds-accent-contrast)', borderColor: 'var(--ds-blue)' }
                : undefined
            }
          >
            {syncStatus === 'syncing' ? (
              <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            )}
            立即同步
          </button>
        </div>

        {syncMessage && (
          <div
            className="text-[11px] px-3 py-2 rounded-lg"
            style={{
              color: syncStatus === 'error' ? 'var(--ds-status-error)' : 'var(--ds-status-success)',
              background: syncStatus === 'error' ? 'var(--ds-status-error-bg)' : 'var(--ds-status-success-bg)',
              border: `1px solid ${syncStatus === 'error' ? 'var(--ds-status-error-border)' : 'var(--ds-status-success-border)'}`,
            }}
          >
            {syncMessage}
          </div>
        )}

        <div className="text-[11px] text-center" style={{ color: 'var(--ds-text-tertiary)' }}>
          上次同步: {formatTime(syncConfig.lastSyncAt)}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
          数据管理
        </h2>
{/* 
        <div className="ds-surface-panel rounded-xl p-4 space-y-3">
          <div className="flex justify-between items-center text-xs">
            <span style={{ color: 'var(--ds-text-secondary)' }}>记忆总数</span>
            <span className="font-semibold" style={{ color: 'var(--ds-blue)' }}>
              {memoryCount} 条
            </span>
          </div>
          <div className="border-t border-dashed" style={{ borderColor: 'var(--ds-border)' }} />
          <div className="flex justify-between items-center text-xs">
            <span style={{ color: 'var(--ds-text-secondary)' }}>自定义 Skill</span>
            <span className="font-semibold" style={{ color: 'var(--ds-blue)' }}>
              {customSkillCount} 个
            </span>
          </div>
          <div className="border-t border-dashed" style={{ borderColor: 'var(--ds-border)' }} />
          <div className="flex justify-between items-center text-xs">
            <span style={{ color: 'var(--ds-text-secondary)' }}>系统预设</span>
            <span className="font-semibold" style={{ color: 'var(--ds-blue)' }}>
              {presetCount} 个
            </span>
          </div>
        </div> */}

        <div className="ds-surface-panel rounded-xl p-4 space-y-2">
          <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
            导出数据选择
          </div>
          <div className="grid grid-cols-4 gap-2">
            {BACKUP_OPTIONS.map((option) => {
              const selected = backupSelection[option.key];
              const count = option.getCount({ memories: memoryCount, skills: customSkillCount, presets: presetCount, mcpServers: mcpServerCount });
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => toggleBackupSelection(option.key)}
                  className="rounded-lg border px-2.5 py-2 text-left transition-all duration-150"
                  style={{
                    borderColor: selected ? 'var(--ds-blue)' : 'var(--ds-border)',
                    background: selected ? 'var(--ds-accent-muted)' : 'var(--ds-bg)',
                    color: selected ? 'var(--ds-blue)' : 'var(--ds-text-secondary)',
                  }}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-medium">
                    <span
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border text-[9px]"
                      style={{
                        borderColor: selected ? 'var(--ds-blue)' : 'var(--ds-border)',
                        background: selected ? 'var(--ds-blue)' : 'transparent',
                        color: selected ? 'var(--ds-accent-contrast)' : 'transparent',
                      }}
                    >
                      ✓
                    </span>
                    {option.label}
                  </span>
                  <span className="mt-1 block text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>
                    {count} {option.key === 'memories' ? '条' : '个'}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="text-[10px] leading-relaxed" style={{ color: 'var(--ds-text-tertiary)' }}>
            导入备份会与当前数据合并：同一记忆 syncId、同名 Skill、同 ID 预设会更新，不会清空现有数据。
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleExport}
            disabled={!hasBackupSelection}
            className="ds-btn-secondary flex-1 py-2.5 text-xs font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.download} />
            </svg>
            导出备份
          </button>
          <button
            onClick={handleImport}
            className="ds-btn-secondary flex-1 py-2.5 text-xs font-medium rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.upload} />
            </svg>
            导入备份
          </button>
        </div>

        <button
          onClick={handleClearAll}
          className="ds-btn-danger w-full py-2.5 text-xs font-medium rounded-lg transition-all duration-150"
        >
          清除所有数据
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
          关于
        </h2>
        <div className="ds-surface-panel rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-[11px] font-bold"
              style={{ background: 'linear-gradient(135deg, var(--ds-blue), #7C8FFF)' }}
            >
              D+
            </div>
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--ds-text)' }}>
                WebTool-DeepSeek v{version}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--ds-text-tertiary)' }}>
                Agentic 记忆与 Skill 系统
              </div>
            </div>
          </div>
          <a
            href="https://github.com/illegal-xd/WebTool-DeepSeek"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] mt-1 transition-colors hover:opacity-80"
            style={{ color: 'var(--ds-text-secondary)' }}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            项目地址：GitHub
          </a>
          <a
            href="https://github.com/zhu1090093659/deepseek-pp"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] mt-1 transition-colors hover:opacity-80"
            style={{ color: 'var(--ds-text-secondary)' }}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            原项目地址：GitHub
          </a>
        </div>
      </section>
    </div>
  );
}
