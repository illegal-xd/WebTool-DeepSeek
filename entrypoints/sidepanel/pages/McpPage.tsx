import { useCallback, useEffect, useMemo, useState } from 'react';
import type { McpServerConfig, McpServerCreateInput, McpToolCacheEntry, ToolCallHistoryRecord, ToolExecutionMode } from '../../../core/types';
import SidepanelModal from '../components/SidepanelModal';

type TransportKind = McpServerCreateInput['transport']['kind'];

type FormState = {
  displayName: string;
  enabled: boolean;
  kind: TransportKind;
  url: string;
  nativeHost: string;
  command: string;
  args: string;
  executionMode: ToolExecutionMode;
};

const DEFAULT_FORM: FormState = {
  displayName: '',
  enabled: true,
  kind: 'streamable_http',
  url: '',
  nativeHost: '',
  command: '',
  args: '',
  executionMode: 'auto',
};

const TRANSPORTS: Array<{ kind: TransportKind; label: string }> = [
  { kind: 'streamable_http', label: '流式 HTTP' },
  { kind: 'http', label: 'HTTP POST' },
  { kind: 'sse', label: 'SSE 事件流' },
  { kind: 'stdio_bridge', label: '标准输入输出桥接' },
  { kind: 'native_messaging', label: '原生消息主机' },
];

const STATUS_LABELS: Record<McpServerConfig['status'] | 'disabled', string> = {
  unknown: '未检测',
  ready: '可用',
  error: '异常',
  disabled: '已停用',
};

function getTransportLabel(kind: TransportKind): string {
  return TRANSPORTS.find((item) => item.kind === kind)?.label ?? kind;
}

function getStatusLabel(server: McpServerConfig): string {
  return server.enabled ? STATUS_LABELS[server.status] : STATUS_LABELS.disabled;
}

function getMcpOriginPattern(server: McpServerConfig): string | null {
  const url = server.transport.url;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

async function requestMcpOriginPermissionFromUserGesture(server: McpServerConfig): Promise<{ ok: boolean; origin?: string; error?: string }> {
  if (server.transport.kind === 'native_messaging') return { ok: true };
  const origin = getMcpOriginPattern(server);
  if (!origin) return { ok: false, error: 'MCP 服务 URL 无效或为空' };
  if (!chrome.permissions?.contains || !chrome.permissions?.request) return { ok: true, origin };

  const granted = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
  if (granted) return { ok: true, origin };

  const ok = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  return ok ? { ok: true, origin } : { ok: false, origin, error: `权限未授予：${origin}` };
}

export default function McpPage() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [caches, setCaches] = useState<Record<string, McpToolCacheEntry | null>>({});
  const [history, setHistory] = useState<ToolCallHistoryRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const selected = servers.find((server) => server.id === selectedId) ?? servers[0] ?? null;
  const selectedCache = selected ? caches[selected.id] ?? null : null;
  const mcpHistory = history.filter((record) => record.call.provider?.kind === 'mcp');
  const totalTools = useMemo(() => Object.values(caches).reduce((sum, cache) => sum + (cache?.descriptors.length ?? 0), 0), [caches]);

  const load = useCallback(async () => {
    const list = await chrome.runtime.sendMessage({ type: 'GET_MCP_SERVERS' }) as McpServerConfig[] | null;
    const nextServers = list ?? [];
    setServers(nextServers);
    setSelectedId((current) => current && nextServers.some((server) => server.id === current) ? current : nextServers[0]?.id ?? null);

    const cacheEntries = await Promise.all(nextServers.map(async (server) => {
      const cache = await chrome.runtime.sendMessage({ type: 'GET_MCP_TOOL_CACHE', payload: { serverId: server.id } }) as McpToolCacheEntry | null;
      return [server.id, cache] as const;
    }));
    setCaches(Object.fromEntries(cacheEntries));

    const recent = await chrome.runtime.sendMessage({ type: 'GET_TOOL_CALL_HISTORY', payload: { limit: 20 } }) as ToolCallHistoryRecord[] | null;
    setHistory(recent ?? []);
  }, []);

  useEffect(() => {
    void load();
    const listener = (msg: { type?: string }) => {
      if (msg.type === 'MCP_SERVERS_UPDATED' || msg.type === 'TOOL_DESCRIPTORS_UPDATED' || msg.type === 'TOOL_CALL_HISTORY_UPDATED') void load();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [load]);

  const startCreate = () => {
    setEditing(null);
    setForm(DEFAULT_FORM);
    setMessage('');
    setShowForm(true);
  };

  const startEdit = (server: McpServerConfig) => {
    setEditing(server);
    setForm({
      displayName: server.displayName,
      enabled: server.enabled,
      kind: server.transport.kind,
      url: server.transport.url ?? '',
      nativeHost: server.transport.nativeHost ?? '',
      command: server.transport.command ?? '',
      args: (server.transport.args ?? []).join(' '),
      executionMode: server.execution.mode,
    });
    setMessage('');
    setShowForm(true);
  };

  const save = async () => {
    const payload: McpServerCreateInput = {
      displayName: form.displayName.trim() || 'MCP 服务',
      enabled: form.enabled,
      transport: {
        kind: form.kind,
        url: form.url.trim() || undefined,
        nativeHost: form.nativeHost.trim() || undefined,
        command: form.command.trim() || undefined,
        args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
      },
      execution: { enabled: true, mode: form.executionMode },
    };

    const response = editing
      ? await chrome.runtime.sendMessage({ type: 'UPDATE_MCP_SERVER', payload: { id: editing.id, patch: payload } })
      : await chrome.runtime.sendMessage({ type: 'CREATE_MCP_SERVER', payload });
    if (!response) {
      setMessage('保存失败，请检查配置');
      return;
    }
    setShowForm(false);
    setEditing(null);
    await load();
  };

  const remove = async (server: McpServerConfig) => {
    if (!confirm(`删除 MCP 服务「${server.displayName}」？`)) return;
    await chrome.runtime.sendMessage({ type: 'DELETE_MCP_SERVER', payload: { id: server.id } });
    await load();
  };

  const clearMcpHistory = async () => {
    if (!selected) return;
    if (!confirm('清空操作将删除所有记录的 mcp 调用数据，请确认删除！')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_TOOL_CALL_HISTORY', payload: { serverId: selected.id } });
    await load();
  };

  const refresh = async (server: McpServerConfig, testOnly = false) => {
    setBusyId(server.id);
    setMessage('');
    try {
      if (server.transport.kind !== 'native_messaging') {
        const permission = await requestMcpOriginPermissionFromUserGesture(server);
        if (permission?.ok === false) {
          setMessage(`权限未授予：${permission.error || permission.origin || '无法访问该 MCP 服务地址'}`);
          return;
        }
      }
      const result = await chrome.runtime.sendMessage({ type: testOnly ? 'TEST_MCP_SERVER_CONNECTION' : 'REFRESH_MCP_SERVER_TOOLS', payload: { serverId: server.id } });
      const cache = testOnly ? result?.cache : result;
      setMessage(cache?.health?.status === 'ready' ? `连接成功，发现 ${cache.health.toolCount} 个工具` : cache?.health?.error ?? '连接失败');
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = async (server: McpServerConfig) => {
    await chrome.runtime.sendMessage({ type: 'UPDATE_MCP_SERVER', payload: { id: server.id, patch: { enabled: !server.enabled } } });
    await load();
  };

  return (
    <div className="p-4 space-y-4">
      <section className="ds-surface-panel rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold" style={{ color: 'var(--ds-text)' }}>MCP 工具</h2>
            <p className="text-[12px] mt-1" style={{ color: 'var(--ds-text-secondary)' }}>
              {servers.length} 个服务 · {totalTools} 个已发现工具
            </p>
          </div>
          <button type="button" className="ds-btn-primary px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150 flex items-center gap-1 shrink-0" onClick={startCreate}>
            <svg aria-hidden="true" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            新增服务
          </button>
        </div>
        {message && <div className="mt-3 text-[12px] rounded-xl px-3 py-2 ds-info-panel" style={{ color: 'var(--ds-blue)' }}>{message}</div>}
      </section>

      {showForm && (
        <SidepanelModal open={showForm} title={editing ? '编辑 MCP 服务' : '新增 MCP 服务'} maxWidth="lg" onClose={() => setShowForm(false)}>
            <section className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[12px] col-span-2" style={{ color: 'var(--ds-text-secondary)' }}>
                  名称
                  <input className="ds-input mt-1 w-full rounded-xl px-3 py-2 text-[13px]" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="例如：本地文件工具" />
                </label>
                <label className="text-[12px]" style={{ color: 'var(--ds-text-secondary)' }}>
                  传输
                  <select className="ds-input mt-1 w-full rounded-xl px-3 py-2 text-[13px]" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as TransportKind })}>
                    {TRANSPORTS.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
                  </select>
                </label>
                <label className="text-[12px]" style={{ color: 'var(--ds-text-secondary)' }}>
                  执行策略
                  <select className="ds-input mt-1 w-full rounded-xl px-3 py-2 text-[13px]" value={form.executionMode} onChange={(e) => setForm({ ...form, executionMode: e.target.value as ToolExecutionMode })}>
                    <option value="auto">自动</option>
                    <option value="manual">手动</option>
                    <option value="disabled">禁用</option>
                  </select>
                </label>
                <label className="text-[12px] col-span-2" style={{ color: 'var(--ds-text-secondary)' }}>
                  URL / Bridge 地址
                  <input className="ds-input mt-1 w-full rounded-xl px-3 py-2 text-[13px]" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://localhost:3000/mcp" />
                </label>
                <label className="text-[12px] col-span-2" style={{ color: 'var(--ds-text-secondary)' }}>
                  Native Host
                  <input className="ds-input mt-1 w-full rounded-xl px-3 py-2 text-[13px]" value={form.nativeHost} onChange={(e) => setForm({ ...form, nativeHost: e.target.value })} placeholder="com.example.mcp_host" />
                </label>
                <label className="text-[12px]" style={{ color: 'var(--ds-text-secondary)' }}>
                  命令
                  <input className="ds-input mt-1 w-full rounded-xl px-3 py-2 text-[13px]" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="node" />
                </label>
                <label className="text-[12px]" style={{ color: 'var(--ds-text-secondary)' }}>
                  参数
                  <input className="ds-input mt-1 w-full rounded-xl px-3 py-2 text-[13px]" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="server.js" />
                </label>
              </div>
              <label className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--ds-text-secondary)' }}>
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 启用服务
              </label>
              <div className="flex gap-2 justify-end pt-1">
                <button type="button" className="ds-btn-cancel px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-150" onClick={() => setShowForm(false)}>取消</button>
                <button type="button" className="ds-btn-primary px-4 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150" onClick={save}>保存</button>
              </div>
            </section>
        </SidepanelModal>
      )}

      <section className="grid grid-cols-[145px_1fr] gap-3 min-h-[420px]">
        <div className="space-y-2">
          {servers.map((server) => (
            <button key={server.id} type="button" className="ds-card w-full rounded-2xl p-3 text-left" style={{ borderColor: selected?.id === server.id ? 'var(--ds-blue)' : undefined }} onClick={() => setSelectedId(server.id)}>
              <div className="text-[13px] font-medium truncate" style={{ color: 'var(--ds-text)' }}>{server.displayName}</div>
              <div className="text-[11px] mt-1" style={{ color: server.status === 'ready' ? 'var(--ds-success)' : server.status === 'error' ? 'var(--ds-danger)' : 'var(--ds-text-tertiary)' }}>
                {getStatusLabel(server)} · {getTransportLabel(server.transport.kind)}
              </div>
            </button>
          ))}
          {servers.length === 0 && <div className="text-[12px] p-3" style={{ color: 'var(--ds-text-tertiary)' }}>暂无 MCP 服务</div>}
        </div>

        <div className="ds-card rounded-2xl p-4 min-w-0">
          {selected ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold truncate" style={{ color: 'var(--ds-text)' }}>{selected.displayName}</h3>
                  <p className="text-[12px] mt-1 truncate" style={{ color: 'var(--ds-text-secondary)' }}>{selected.transport.url || selected.transport.nativeHost || selected.transport.command || '未配置端点'}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button type="button" className="ds-btn-secondary rounded-lg px-2 py-1 text-[11px]" onClick={() => void toggleEnabled(selected)}>{selected.enabled ? '停用' : '启用'}</button>
                  <button type="button" className="ds-btn-secondary rounded-lg px-2 py-1 text-[11px]" onClick={() => startEdit(selected)}>编辑</button>
                  <button type="button" className="ds-btn-danger rounded-lg px-2 py-1 text-[11px]" onClick={() => void remove(selected)}>删除</button>
                  {/* <button type="button" className="ds-btn-danger rounded-lg px-2 py-1 text-[11px]" onClick={() => void clearMcpHistory()}>清空调用</button> */}
                </div>
              </div>

              <div className="flex gap-2">
                <button type="button" className="ds-btn-primary px-4 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150" disabled={busyId === selected.id} onClick={() => void refresh(selected)}>
                  {busyId === selected.id ? '刷新中...' : '发现工具'}
                </button>
                <button type="button" className="ds-btn-cancel px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-150" disabled={busyId === selected.id} onClick={() => void refresh(selected, true)}>测试连接</button>
              </div>

              <div>
                <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--ds-text-secondary)' }}>工具列表</div>
                <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                  {(selectedCache?.descriptors ?? []).map((tool) => (
                    <div key={tool.id} className="ds-surface-panel rounded-xl p-3">
                      <div className="text-[12px] font-medium" style={{ color: 'var(--ds-text)' }}>{tool.title}</div>
                      <div className="mcp-tool-invocation block max-w-full whitespace-normal break-all text-[11px] mt-1 font-mono leading-snug" style={{ color: 'var(--ds-blue)', overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{tool.invocationName}</div>
                      <p className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--ds-text-secondary)' }}>{tool.description}</p>
                    </div>
                  ))}
                  {!selectedCache?.descriptors.length && <div className="text-[12px]" style={{ color: 'var(--ds-text-tertiary)' }}>尚未发现工具，点击“发现工具”开始。</div>}
                </div>
              </div>

              <div>
                <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--ds-text-secondary)' }}>最近调用</div>
                <div className="space-y-2 max-h-[140px] overflow-y-auto pr-1">
                  {mcpHistory.slice(0, 6).map((record) => (
                    <div key={record.id} className="text-[11px] ds-surface-panel rounded-xl p-2" style={{ color: 'var(--ds-text-secondary)' }}>
                      <span style={{ color: record.result.ok ? 'var(--ds-success)' : 'var(--ds-danger)' }}>{record.result.ok ? '成功' : '失败'}</span>
                      <span> · {record.call.name} · {record.result.summary}</span>
                    </div>
                  ))}
                  {mcpHistory.length === 0 && <div className="text-[12px]" style={{ color: 'var(--ds-text-tertiary)' }}>暂无 MCP 调用记录</div>}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-[13px]" style={{ color: 'var(--ds-text-tertiary)' }}>选择或新增一个 MCP 服务。</div>
          )}
        </div>
      </section>
    </div>
  );
}
