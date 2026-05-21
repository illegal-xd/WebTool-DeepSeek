import { useState, useEffect } from 'react';
import type { SystemPromptPreset, Memory, MemoryType } from '../../../core/types';
import { MEMORY_TYPE_CONFIG, MEMORY_TYPE_MAP } from '../constants';

interface Props {
  initial?: SystemPromptPreset;
  onSave: (preset: SystemPromptPreset) => void;
  onCancel: () => void;
  onWidthChange?: (isWide: boolean) => void;
}

const FILTER_TYPES: { key: MemoryType | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  ...MEMORY_TYPE_CONFIG.map((t) => ({ key: t.key, label: t.label })),
];

export default function PresetForm({ initial, onSave, onCancel, onWidthChange }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [memoryEnabled, setMemoryEnabled] = useState(initial?.memoryEnabled ?? false);
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<number[]>(initial?.memoryIds ?? []);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<MemoryType | 'all'>('all');

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_MEMORIES' }).then((res) => {
      setMemories(res ?? []);
    });
  }, []);

  useEffect(() => {
    onWidthChange?.(memoryEnabled);
  }, [memoryEnabled, onWidthChange]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    const now = Date.now();
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      content: content.trim(),
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
      memoryEnabled,
      memoryIds: memoryEnabled ? selectedMemoryIds : [],
    });
  };

  const toggleMemory = (id: number) => {
    setSelectedMemoryIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSelectAllFiltered = () => {
    const filteredIds = filteredMemories
      .map((m) => m.id)
      .filter((id): id is number => id !== undefined);
    setSelectedMemoryIds((prev) => {
      const next = [...prev];
      filteredIds.forEach((id) => {
        if (!next.includes(id)) {
          next.push(id);
        }
      });
      return next;
    });
  };

  const handleClearFiltered = () => {
    const filteredIds = filteredMemories
      .map((m) => m.id)
      .filter((id): id is number => id !== undefined);
    setSelectedMemoryIds((prev) => prev.filter((id) => !filteredIds.includes(id)));
  };

  const filteredMemories = memories.filter((m) => {
    // Type Filter
    if (filter !== 'all' && m.type !== filter) return false;

    // Search Query (including tags)
    const q = searchQuery.toLowerCase();
    return (
      m.name.toLowerCase().includes(q) ||
      m.content.toLowerCase().includes(q) ||
      m.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <div
      className="ds-form rounded-xl flex overflow-hidden transition-all duration-300"
      style={{
        background: 'var(--ds-bg)',
        borderColor: 'var(--ds-blue)',
      }}
    >
      {/* Left Column: Form Fields */}
      <form onSubmit={handleSubmit} className="flex-1 p-4 space-y-3 min-w-[280px]">
        <div className="flex items-center justify-between text-xs font-semibold pb-1 border-b border-dashed" style={{ color: 'var(--ds-text-secondary)', borderColor: 'var(--ds-border)' }}>
          <span>{initial ? '编辑系统预设' : '新建系统预设'}</span>
        </div>
        <input
          type="text"
          placeholder="预设名称（如：代码助手、翻译专家）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="ds-input w-full px-3 py-2 text-sm rounded-lg transition-all duration-150"
        />

        <div>
          <label className="text-[11px] mb-1.5 block font-medium" style={{ color: 'var(--ds-text-tertiary)' }}>
            系统提示词内容
          </label>
          <textarea
            rows={12}
            placeholder={"你是一位专业的...\\n\\n## 核心原则\\n- ..."}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="ds-input w-full px-3 py-2 text-sm font-mono rounded-lg resize-none transition-all duration-150"
          />
        </div>

        {/* Switch Toggle for Memory Injection */}
        <div className="flex items-center justify-between p-2 rounded-lg border border-dashed" style={{ borderColor: 'var(--ds-border)' }}>
          <div className="flex flex-col pr-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--ds-text-secondary)' }}>启用记忆注入</span>
            <span className="text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>使用该预设时注入关联的记忆数据，启用后不选择记忆数据默认传递所有记忆</span>
          </div>
          <button
            type="button"
            onClick={() => setMemoryEnabled(!memoryEnabled)}
            className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
            style={{
              backgroundColor: memoryEnabled ? 'var(--ds-blue)' : 'var(--ds-border)',
            }}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                memoryEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="ds-btn-cancel px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-150"
          >
            取消
          </button>
          <button
            type="submit"
            className="ds-btn-primary px-4 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150"
          >
            {initial ? '更新' : '保存'}
          </button>
        </div>
      </form>

      {/* Right Column: Memory Selector (only shown if memoryEnabled is true) */}
      {memoryEnabled && (
        <div className="w-[320px] border-l flex flex-col p-4 bg-gray-50/50 dark:bg-zinc-900/10" style={{ borderColor: 'var(--ds-border)' }}>
          <div className="flex items-center justify-between text-xs font-semibold pb-1 border-b border-dashed mb-3" style={{ color: 'var(--ds-text-secondary)', borderColor: 'var(--ds-border)' }}>
            <span>选择要注入的记忆 ({selectedMemoryIds.length}/{memories.length})</span>
            {filteredMemories.length > 0 && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleSelectAllFiltered}
                  className="px-2 py-0.5 text-[11px] font-medium rounded-full transition-all duration-150 cursor-pointer hover:brightness-95 active:scale-95 border border-solid"
                  style={{
                    color: 'var(--ds-blue)',
                    background: 'var(--ds-blue-light)',
                    borderColor: 'rgba(77, 107, 254, 0.25)',
                  }}
                >
                  全选
                </button>
                <button
                  type="button"
                  onClick={handleClearFiltered}
                  className="px-2 py-0.5 text-[11px] font-medium rounded-full transition-all duration-150 cursor-pointer hover:brightness-95 active:scale-95 border border-solid"
                  style={{
                    color: 'var(--ds-danger)',
                    background: 'var(--ds-danger-bg)',
                    borderColor: 'var(--ds-danger-border)',
                  }}
                >
                  清除
                </button>
              </div>
            )}
          </div>

          <input
            type="text"
            placeholder="搜索记忆 (名称/内容/标签)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ds-input w-full px-2.5 py-1.5 text-xs rounded-lg mb-2 transition-all duration-150"
          />

          <div className="flex gap-1.5 flex-wrap mb-3">
            {FILTER_TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilter(t.key)}
                className="px-2.5 py-0.5 text-[10px] rounded-full transition-all duration-150 border"
                style={{
                  background: filter === t.key ? 'var(--ds-blue-light)' : 'var(--ds-surface)',
                  color: filter === t.key ? 'var(--ds-blue)' : 'var(--ds-text-secondary)',
                  borderColor: filter === t.key ? 'rgba(77,107,254,0.2)' : 'var(--ds-border)',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[420px] custom-scrollbar">
            {filteredMemories.length === 0 ? (
              <div className="text-xs text-center py-8 font-medium" style={{ color: 'var(--ds-text-tertiary)' }}>
                {memories.length === 0 ? '暂无记忆数据，请先在记忆分栏创建' : '没有匹配的记忆'}
              </div>
            ) : (
              filteredMemories.map(m => {
                const isSelected = m.id !== undefined && selectedMemoryIds.includes(m.id);
                const typeInfo = MEMORY_TYPE_MAP[m.type] ?? MEMORY_TYPE_MAP.topic;
                return (
                  <div
                    key={m.id}
                    onClick={() => m.id !== undefined && toggleMemory(m.id)}
                    className="p-2.5 rounded-lg border cursor-pointer transition-all duration-150 select-none flex flex-col gap-1"
                    style={{
                      borderWidth: '1px',
                      borderColor: isSelected ? 'var(--ds-blue)' : 'var(--ds-border)',
                      backgroundColor: isSelected ? 'var(--ds-blue-glow)' : 'var(--ds-surface)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-xs truncate max-w-[180px]" style={{ color: 'var(--ds-text)' }}>
                        {m.name}
                      </span>
                      <span
                        className="text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0"
                        style={{
                          backgroundColor: typeInfo.bg,
                          color: typeInfo.color,
                          border: `1px solid ${typeInfo.border}`,
                        }}
                      >
                        {typeInfo.label}
                      </span>
                    </div>
                    <p className="text-[10px] line-clamp-2 leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
                      {m.content}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
