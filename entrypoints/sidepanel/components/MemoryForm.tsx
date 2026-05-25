import { useMemo, useState } from 'react';
import type { Memory, MemoryScope, MemoryType, NewMemory } from '../../../core/types';
import { memoryUsageScore, memoryRecencyScore } from '../../../core/weighting';
import { MEMORY_TYPE_CONFIG } from '../constants';

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

interface Props {
  initial?: Memory | null;
  onSave: (mem: NewMemory) => void;
  onCancel: () => void;
}

const SCOPE_OPTIONS: { key: MemoryScope; label: string; weight: number; color: string }[] = [
  { key: 'temporary', label: '低', weight: 80, color: '#f59e0b' },
  { key: 'contextual', label: '中', weight: 180, color: '#3b82f6' },
  { key: 'permanent', label: '高', weight: 300, color: '#10b981' },
];

function defaultScope(type: MemoryType): MemoryScope {
  return type === 'user' || type === 'feedback' ? 'permanent' : 'contextual';
}

export default function MemoryForm({ initial, onSave, onCancel }: Props) {
  const [type, setType] = useState<MemoryType>(initial?.type ?? 'topic');
  const [name, setName] = useState(initial?.name ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
  const [scope, setScope] = useState<MemoryScope>(initial?.scope ?? defaultScope(initial?.type ?? 'topic'));
  const [pinned] = useState(initial?.pinned ?? false);

  const scopeIndex = SCOPE_OPTIONS.findIndex((o) => o.key === scope);

  const weightBreakdown = useMemo(() => {
    const base = round2(SCOPE_OPTIONS.find((o) => o.key === scope)?.weight ?? 0);
    const pinnedBonus = round2(pinned ? 1000 : 0);
    const usageScore = round2(memoryUsageScore(initial?.accessCount ?? 0));
    const recencyScore = round2(memoryRecencyScore(initial?.lastAccessedAt ?? Date.now()));
    const subtotal = round2(base + pinnedBonus + usageScore + recencyScore);
    // Total weight at each level (for slider labels)
    const levelTotals = SCOPE_OPTIONS.map((opt) => {
      const lvlBase = round2(opt.weight);
      return round2(lvlBase + pinnedBonus + usageScore + recencyScore);
    });
    return { base, pinnedBonus, usageScore, recencyScore, subtotal, levelTotals };
  }, [scope, pinned, initial?.accessCount, initial?.lastAccessedAt]);

  const handleTypeChange = (newType: MemoryType) => {
    setType(newType);
    if (!initial) {
      setScope(defaultScope(newType));
    }
  };

  const handleScopeSlider = (index: number) => {
    setScope(SCOPE_OPTIONS[index].key);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    onSave({
      type,
      scope,
      name: name.trim(),
      content: content.trim(),
      description: name.trim(),
      tags: tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      pinned: initial?.pinned ?? false,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 space-y-3">
      <div className="flex gap-1.5">
        {MEMORY_TYPE_CONFIG.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => handleTypeChange(t.key)}
            className="px-2.5 py-1 text-[11px] rounded-md font-medium transition-all duration-150"
            style={{
              background: type === t.key ? t.bg : 'var(--ds-surface)',
              color: type === t.key ? t.color : 'var(--ds-text-tertiary)',
              border: `1px solid ${type === t.key ? t.color + '33' : 'var(--ds-border)'}`,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <input
        type="text"
        placeholder="标题"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="ds-input w-full px-3 py-2 text-sm rounded-lg transition-all duration-150"
      />

      <textarea
        placeholder="内容"
        rows={6}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="ds-input w-full px-3 py-2 text-sm rounded-lg resize-none transition-all duration-150"
      />

      <input
        type="text"
        placeholder="标签（逗号分隔）"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        className="ds-input w-full px-3 py-2 text-sm rounded-lg transition-all duration-150"
      />

      {/* Weight slider */}
      <div className="pt-1 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium" style={{ color: 'var(--ds-text-secondary)' }}>
            注入权重
          </span>
          <span className="text-xs font-semibold tabular-nums" style={{ color: SCOPE_OPTIONS[scopeIndex].color }}>
            {weightBreakdown.subtotal.toFixed(2)}
          </span>
        </div>

        {/* Slider track */}
        <div className="relative h-7 flex items-center">
          {/* Background track */}
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full" style={{ background: 'var(--ds-border)' }} />

          {/* Active fill */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full transition-all duration-300"
            style={{
              width: `${(scopeIndex / (SCOPE_OPTIONS.length - 1)) * 100}%`,
              background: `linear-gradient(to right, ${SCOPE_OPTIONS[0].color}, ${SCOPE_OPTIONS[scopeIndex].color})`,
            }}
          />

          {/* Step markers */}
          {SCOPE_OPTIONS.map((opt, i) => {
            const pct = (i / (SCOPE_OPTIONS.length - 1)) * 100;
            const isActive = i <= scopeIndex;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => handleScopeSlider(i)}
                className="absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 transition-all duration-200 hover:scale-110 focus:outline-none"
                style={{
                  left: `calc(${pct}% - 10px)`,
                  borderColor: isActive ? opt.color : 'var(--ds-border)',
                  background: isActive ? opt.color : 'var(--ds-bg)',
                  boxShadow: isActive ? `0 0 0 3px ${opt.color}22` : 'none',
                }}
                aria-label={opt.label}
              />
            );
          })}
        </div>

        {/* Step labels */}
        <div className="flex justify-between px-0">
          {SCOPE_OPTIONS.map((opt, i) => {
            const isActive = scopeIndex === i;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => handleScopeSlider(i)}
                className="flex flex-col items-center gap-0.5 transition-all duration-200"
                style={{ opacity: isActive ? 1 : 0.5 }}
              >
                <span
                  className="text-[11px] font-semibold leading-tight"
                  style={{ color: isActive ? opt.color : 'var(--ds-text-tertiary)' }}
                >
                  {opt.label}
                </span>
                <span className="text-[10px] tabular-nums leading-tight" style={{ color: 'var(--ds-text-tertiary)' }}>
                  {weightBreakdown.levelTotals[i].toFixed(2)}
                </span>
              </button>
            );
          })}
        </div>

        {/* Weight breakdown */}
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-2 rounded-lg text-[11px]"
          style={{ background: 'var(--ds-surface)', color: 'var(--ds-text-tertiary)' }}
        >
          <span>基值</span>
          <span className="tabular-nums font-medium" style={{ color: SCOPE_OPTIONS[scopeIndex].color }}>
            +{weightBreakdown.base.toFixed(2)}
          </span>

          <span className="text-[12px]" style={{ color: 'var(--ds-text-quaternary)' }}>+</span>
          <span>使用频次</span>
          <span className="tabular-nums font-medium" style={{ color: '#8b5cf6' }}>+{weightBreakdown.usageScore.toFixed(2)}</span>

          <span className="text-[12px]" style={{ color: 'var(--ds-text-quaternary)' }}>+</span>
          <span>新鲜度</span>
          <span className="tabular-nums font-medium" style={{ color: '#06b6d4' }}>+{weightBreakdown.recencyScore.toFixed(2)}</span>

          {pinned && (
            <>
              <span className="text-[12px]" style={{ color: 'var(--ds-text-quaternary)' }}>+</span>
              <span>置顶</span>
              <span className="tabular-nums font-medium" style={{ color: '#f59e0b' }}>+{weightBreakdown.pinnedBonus.toFixed(2)}</span>
            </>
          )}

          <span className="ml-auto font-semibold tabular-nums text-xs" style={{ color: SCOPE_OPTIONS[scopeIndex].color }}>
            = {weightBreakdown.subtotal.toFixed(2)}
          </span>
        </div>

        {/* Keyword note */}
        <div className="text-[10px] leading-tight px-0.5" style={{ color: 'var(--ds-text-quaternary, #9ca3af)' }}>
          * 关键词匹配加分（KEYWORD +0~N）在 AI 注入时按当前对话动态计算
        </div>
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
  );
}
