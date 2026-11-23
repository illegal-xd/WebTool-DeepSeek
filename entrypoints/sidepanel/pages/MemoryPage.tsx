import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Memory, MemoryType, NewMemory } from '../../../core/types';
import { memoryMatchScore, memoryWeight } from '../../../core/weighting';
import type { MemoryCandidate } from '../../../core/memory/candidates';
import { computeMemoryHealth } from '../../../core/memory/health';
import MemoryCard from '../components/MemoryCard';
import MemoryForm from '../components/MemoryForm';
import SidepanelModal from '../components/SidepanelModal';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import { MEMORY_TYPE_CONFIG } from '../constants';

const FILTER_TYPES: { key: MemoryType | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  ...MEMORY_TYPE_CONFIG.map((t) => ({ key: t.key, label: t.label })),
];

type MemorySortKey = 'recentlyUpdated' | 'highestWeight' | 'mostUsed';

const SORT_OPTIONS: { key: MemorySortKey; label: string }[] = [
  { key: 'highestWeight', label: '按最高权重' },
  { key: 'recentlyUpdated', label: '按最近更新' },
  { key: 'mostUsed', label: '按最多使用' },
];

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [archived, setArchived] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<MemoryType | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<MemorySortKey>('highestWeight');
  const [showForm, setShowForm] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [tokenBudget, setTokenBudget] = useState<number | null>(null);
  const [showHealth, setShowHealth] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, config, pending] = await Promise.all([
        chrome.runtime.sendMessage({
          type: 'GET_MEMORIES',
          payload: { includeArchived: true },
        }) as Promise<Memory[]>,
        chrome.runtime.sendMessage({ type: 'GET_MEMORY_CONFIG' }) as Promise<{ tokenBudget?: number } | null>,
        chrome.runtime.sendMessage({
          type: 'GET_MEMORY_CANDIDATES',
          payload: { status: 'pending' },
        }) as Promise<MemoryCandidate[]>,
      ]);
      setMemories((all ?? []).filter((memory) => !memory.archivedAt));
      setArchived((all ?? []).filter((memory) => Boolean(memory.archivedAt)));
      setCandidates(pending ?? []);
      if (typeof config?.tokenBudget === 'number') setTokenBudget(config.tokenBudget);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Listen for state updates from background (e.g., AI tool calls)
  useEffect(() => {
    const handler = (message: { type: string }) => {
      if (message.type === 'STATE_UPDATED' || message.type === 'MEMORY_CANDIDATES_UPDATED') {
        load();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [load]);

  const filtered = useMemo(() => {
    const keyword = searchQuery.trim();
    return memories
      .filter((memory) => {
        if (filter !== 'all' && memory.type !== filter) return false;
        if (!keyword) return true;
        return memoryMatchScore(memory, keyword) > 0;
      })
      .toSorted((a, b) => {
        if (sortKey === 'highestWeight') {
          return (
            memoryWeight(b) - memoryWeight(a) ||
            b.updatedAt - a.updatedAt ||
            a.name.localeCompare(b.name)
          );
        }

        if (sortKey === 'mostUsed') {
          return (
            b.accessCount - a.accessCount ||
            b.lastAccessedAt - a.lastAccessedAt ||
            a.name.localeCompare(b.name)
          );
        }

        return (
          b.updatedAt - a.updatedAt ||
          memoryWeight(b) - memoryWeight(a) ||
          a.name.localeCompare(b.name)
        );
      });
  }, [filter, memories, searchQuery, sortKey]);

  const handleDelete = async (id: number) => {
    if (editingMemory?.id === id) {
      setEditingMemory(null);
      setShowForm(false);
    }
    await chrome.runtime.sendMessage({ type: 'DELETE_MEMORY', payload: { id } });
    load();
  };

  const handleSave = async (mem: NewMemory) => {
    if (editingMemory?.id) {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_MEMORY',
        payload: { ...editingMemory, ...mem, updatedAt: Date.now() },
      });
    } else {
      await chrome.runtime.sendMessage({ type: 'SAVE_MEMORY', payload: mem });
    }
    setShowForm(false);
    setEditingMemory(null);
    load();
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingMemory(null);
  };

  const health = useMemo(
    () => computeMemoryHealth(memories, {
      tokenBudget: tokenBudget ?? undefined,
      archivedCount: archived.length,
    }),
    [memories, archived.length, tokenBudget],
  );

  const handleAcceptCandidate = async (candidate: MemoryCandidate) => {
    await chrome.runtime.sendMessage({
      type: 'SAVE_MEMORY',
      payload: {
        type: candidate.type,
        name: candidate.name,
        content: candidate.content,
        tags: candidate.tags,
        pinned: false,
        scope: candidate.scope,
      } satisfies NewMemory,
    });
    await chrome.runtime.sendMessage({
      type: 'SET_MEMORY_CANDIDATE_STATUS',
      payload: { id: candidate.id, status: 'accepted' },
    });
    load();
  };

  const handleDismissCandidate = async (candidate: MemoryCandidate) => {
    await chrome.runtime.sendMessage({
      type: 'SET_MEMORY_CANDIDATE_STATUS',
      payload: { id: candidate.id, status: 'dismissed' },
    });
    load();
  };

  const handleEdit = (mem: Memory) => {
    setEditingMemory(mem);
    setShowForm(true);
  };

  const handleTogglePin = async (mem: Memory) => {
    await chrome.runtime.sendMessage({
      type: 'UPDATE_MEMORY',
      payload: { ...mem, pinned: !mem.pinned },
    });
    load();
  };

  const handleRestore = async (id: number) => {
    await chrome.runtime.sendMessage({ type: 'RESTORE_MEMORY', payload: { id } });
    load();
  };

  return (
    <div className="p-4 space-y-3">
      <div
        className="sticky top-0 z-10 space-y-3 border-b"
        style={{
          backgroundColor: 'var(--ds-bg)',
          borderColor: 'var(--ds-border)',
          margin: '-16px -16px 8px -16px',
          padding: '12px 16px',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1.5 flex-wrap">
            {FILTER_TYPES.map((t) => (
              <button
                type="button"
                key={t.key}
                onClick={() => setFilter(t.key)}
                className="px-2.5 py-1 text-xs rounded-full transition-all duration-150"
                style={{
                  background: filter === t.key ? 'var(--ds-blue-light)' : 'var(--ds-surface)',
                  color: filter === t.key ? 'var(--ds-blue)' : 'var(--ds-text-secondary)',
                  fontWeight: filter === t.key ? 500 : 400,
                  border: `1px solid ${filter === t.key ? 'rgba(77,107,254,0.2)' : 'var(--ds-border)'}`,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { setEditingMemory(null); setShowForm(!showForm); }}
            className="ds-btn-primary px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150 flex items-center gap-1 shrink-0"
          >
            <svg aria-hidden="true" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            新增
          </button>
        </div>
        <div className="flex gap-2 items-center">
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索记忆名称或标签..."
            className="min-w-0 flex-1 px-3 py-2 text-xs rounded-lg border outline-none transition-colors focus:border-[var(--ds-blue)]"
            style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)', color: 'var(--ds-text)' }}
          />
          <Select
            className="shrink-0"
            value={sortKey}
            options={SORT_OPTIONS.map((option) => ({ value: option.key, label: option.label }))}
            onChange={setSortKey}
            triggerClassName="rounded-lg px-3 py-2 text-xs"
            ariaLabel="排序方式"
          />
        </div>
      </div>

      {candidates.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--ds-text-secondary)' }}>
              待确认记忆 {candidates.length}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>
              来自对话提炼 · 确认后才写入
            </span>
          </div>
          {candidates.map((candidate) => (
            <div key={candidate.id} className="ds-card rounded-xl p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium truncate" style={{ color: 'var(--ds-text)' }}>
                  {candidate.name}
                </span>
                <span
                  className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--ds-surface)', color: 'var(--ds-text-tertiary)' }}
                >
                  {candidate.scope === 'permanent' ? '永久' : candidate.scope === 'contextual' ? '上下文' : '临时'}
                </span>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
                {candidate.content}
              </p>
              <p className="text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>
                依据：{candidate.reason}
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleDismissCandidate(candidate)}
                  className="ds-btn-cancel px-2.5 py-1 text-[11px] rounded-lg transition-all duration-150"
                >
                  忽略
                </button>
                <button
                  type="button"
                  onClick={() => handleAcceptCandidate(candidate)}
                  className="ds-btn-primary px-2.5 py-1 text-[11px] text-white rounded-lg transition-all duration-150"
                >
                  确认为记忆
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="ds-card rounded-xl p-3.5">
        <button
          type="button"
          onClick={() => setShowHealth((value) => !value)}
          className="w-full flex items-center justify-between text-left"
          aria-expanded={showHealth}
        >
          <span className="text-xs font-semibold" style={{ color: 'var(--ds-text-secondary)' }}>
            记忆体检
          </span>
          <span className="text-[10px] tabular-nums" style={{ color: 'var(--ds-text-tertiary)' }}>
            典型注入 {health.injectionTokens}/{health.injectionBudget} tok {showHealth ? '▴' : '▾'}
          </span>
        </button>

        {showHealth && (
          <div className="mt-2.5 space-y-2">
            <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'var(--ds-surface)' }}>
              <div
                className="h-full rounded-full transition-all duration-200"
                style={{
                  width: `${Math.min(100, health.injectionBudget > 0 ? (health.injectionTokens / health.injectionBudget) * 100 : 0)}%`,
                  background: health.injectionTokens / Math.max(health.injectionBudget, 1) > 0.9 ? 'var(--ds-danger, #EF4444)' : 'var(--ds-blue)',
                }}
              />
            </div>
            <div className="text-[10px] flex flex-wrap gap-x-3 gap-y-1" style={{ color: 'var(--ds-text-tertiary)' }}>
              <span>永久 {health.scopeTokens.permanent} tok</span>
              <span>上下文 {health.scopeTokens.contextual} tok</span>
              <span>临时 {health.scopeTokens.temporary} tok</span>
            </div>
            {health.overCapCount > 0 && (
              <p className="text-[10px]" style={{ color: 'var(--ds-danger, #EF4444)' }}>
                {health.overCapCount} 条记忆超过单条预算上限，永远不会被注入，建议拆分或缩短
              </p>
            )}
            {health.duplicates.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[10px]" style={{ color: 'var(--ds-text-secondary)' }}>
                  内容高度重合 {health.duplicates.length} 组（建议合并，不会自动改动）
                </p>
                {health.duplicates.slice(0, 3).map((pair) => (
                  <p key={`${pair.a.id}-${pair.b.id}`} className="text-[10px] truncate" style={{ color: 'var(--ds-text-tertiary)' }}>
                    {pair.a.name} ≈ {pair.b.name} · {Math.round(pair.similarity * 100)}%
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>
                未发现明显重复记忆
              </p>
            )}
          </div>
        )}
      </div>

      <SidepanelModal open={showForm} title={editingMemory ? '编辑记忆' : '新增记忆'} onClose={handleCancel}>
        <MemoryForm
          key={editingMemory?.id ?? 'new'}
          initial={editingMemory}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      </SidepanelModal>

      {loading ? (
        <Skeleton lines={4} style={{ paddingTop: 4 }} />
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-xl" style={{ background: 'var(--ds-surface)' }}>
            🧠
          </div>
          <p className="text-sm" style={{ color: 'var(--ds-text-tertiary)' }}>
            {memories.length === 0 ? '暂无记忆，对话时会自动积累' : '未找到匹配的记忆'}
          </p>
        </div>
      ) : (
        <div className="ds-list-in space-y-2">
          {filtered.map((m) => (
            <MemoryCard
              key={m.id}
              memory={m}
              onDelete={() => handleDelete(m.id!)}
              onEdit={() => handleEdit(m)}
              onTogglePin={() => handleTogglePin(m)}
            />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <div className="space-y-2 pt-1">
          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            className="w-full text-[11px] px-3 py-2 rounded-lg transition-all duration-150"
            style={{ background: 'var(--ds-surface)', color: 'var(--ds-text-secondary)' }}
          >
            {showArchived ? '收起' : '查看'}已归档 {archived.length} 条（软删除：不参与注入，数据保留）
          </button>
          {showArchived && archived.map((memory) => (
            <div
              key={memory.id}
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg"
              style={{ background: 'var(--ds-surface)' }}
            >
              <div className="min-w-0">
                <div className="text-xs truncate" style={{ color: 'var(--ds-text)' }}>{memory.name}</div>
                <div className="text-[10px] truncate" style={{ color: 'var(--ds-text-tertiary)' }}>{memory.content}</div>
              </div>
              <button
                type="button"
                onClick={() => handleRestore(memory.id!)}
                className="ds-btn-secondary shrink-0 px-2.5 py-1 text-[11px] rounded-lg transition-all duration-150"
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="text-[11px] text-center pt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
        共 {memories.length} 条记忆{archived.length > 0 ? `（另有已归档 ${archived.length} 条）` : ''}
      </div>

      <div className="ds-info-panel rounded-xl p-3.5">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
          在 DeepSeek 输入框中输入{' '}
          <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">
            #
          </code>{' '}
          触发弹窗，选择后写入 <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">#记忆名</code>；可连续输入 <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">#</code> 选择多条（如 <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">#记忆A #记忆B 正文</code>）。输入框中已选的记忆与本对话已注入的记忆会标注并禁止重复选择。例如：
          <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">
            #记忆-对话规则 给我一句每日英语句子
          </code>
        </p>
      </div>
      <div className="ds-info-panel rounded-xl p-3.5">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
          开启「静默注入」的记忆会注入完整正文；未开启的记忆只注入标题与 ID，正文由记忆工具按需读取
        </p>
      </div>
      <div className="ds-info-panel rounded-xl p-3.5">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
          记忆模式数据在不使用 Skill、预设或者单独使用记忆选择时，默认全量输出给 DeepSpeek
        </p>
      </div>
      <div className="ds-info-panel rounded-xl p-3.5">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
          注意：DeepSeek 拥有 128k 上下文，V4 版本拥有 1M 超长上下文，DeepSpeek 本身可以记忆绝大部分数据，当使用了某个记忆之后，DeepSeek 可以做到直接提取上下文对话信息，所以无需重复使用记忆选择能力
        </p>
      </div>
    </div>
  );
}
