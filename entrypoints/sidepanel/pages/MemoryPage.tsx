import { useCallback, useEffect, useState } from 'react';
import type { Memory, MemoryType, NewMemory } from '../../../core/types';
import { memoryWeight } from '../../../core/weighting';
import MemoryCard from '../components/MemoryCard';
import MemoryForm from '../components/MemoryForm';
import SidepanelModal from '../components/SidepanelModal';
import { MEMORY_TYPE_CONFIG } from '../constants';

const FILTER_TYPES: { key: MemoryType | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  ...MEMORY_TYPE_CONFIG.map((t) => ({ key: t.key, label: t.label })),
];

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [filter, setFilter] = useState<MemoryType | 'all'>('all');
  const [showForm, setShowForm] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);

  const load = useCallback(async () => {
    const list: Memory[] = await chrome.runtime.sendMessage({ type: 'GET_MEMORIES' });
    setMemories(list ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Listen for state updates from background (e.g., AI tool calls)
  useEffect(() => {
    const handler = (message: { type: string }) => {
      if (message.type === 'STATE_UPDATED') {
        load();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [load]);

  const filtered = (filter === 'all' ? memories : memories.filter((m) => m.type === filter))
    .toSorted((a, b) => (
      memoryWeight(b) - memoryWeight(a) ||
      b.lastAccessedAt - a.lastAccessedAt ||
      a.name.localeCompare(b.name)
    ));

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

  return (
    <div className="p-4 space-y-3">
      <div
        className="sticky top-0 z-10 flex items-center justify-between border-b"
        style={{
          backgroundColor: 'var(--ds-bg)',
          borderColor: 'var(--ds-border)',
          margin: '-16px -16px 8px -16px',
          padding: '12px 16px',
        }}
      >
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

      <SidepanelModal open={showForm} title={editingMemory ? '编辑记忆' : '新增记忆'} onClose={handleCancel}>
        <MemoryForm
          key={editingMemory?.id ?? 'new'}
          initial={editingMemory}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      </SidepanelModal>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-xl" style={{ background: 'var(--ds-surface)' }}>
            🧠
          </div>
          <p className="text-sm" style={{ color: 'var(--ds-text-tertiary)' }}>
            {memories.length === 0 ? '暂无记忆，对话时会自动积累' : '该分类下暂无记忆'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
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

      <div className="text-[11px] text-center pt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
        共 {memories.length} 条记忆
      </div>

      <div className="ds-info-panel rounded-xl p-3.5">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
          在 DeepSeek 输入框中输入{' '}
          <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">
            #记忆名
          </code>{' '}
          触发。例如：
          <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">
            #记忆-对话规则 给我一句每日英语句子
          </code>
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
