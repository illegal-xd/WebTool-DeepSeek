import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationCategory, ConversationExportFormat, ConversationMessage, ConversationSession } from '../../../core/types';
import { SVG_PATHS } from '../constants';

type FilterKey = 'all' | 'uncategorized' | string;

const CATEGORY_COLORS = ['#4D6BFE', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4'];

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildRenameTitle(template: string, session: ConversationSession, index: number): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return template
    .replaceAll('{idx}', String(index + 1))
    .replaceAll('{date}', `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`)
    .replaceAll('{time}', `${pad(date.getHours())}-${pad(date.getMinutes())}`)
    .replaceAll('{title}', session.title)
    .trim();
}

function highlightTitle(title: string, query: string) {
  const keyword = query.trim();
  if (!keyword) return title;
  const index = title.toLowerCase().indexOf(keyword.toLowerCase());
  if (index === -1) return title;
  return (
    <>
      {title.slice(0, index)}
      <mark className="rounded px-0.5" style={{ background: 'var(--ds-blue-light)', color: 'var(--ds-blue)' }}>
        {title.slice(index, index + keyword.length)}
      </mark>
      {title.slice(index + keyword.length)}
    </>
  );
}

function countOccurrences(text: string, keyword: string): number {
  if (!keyword) return 0;
  let count = 0;
  let index = text.indexOf(keyword);
  while (index !== -1) {
    count++;
    index = text.indexOf(keyword, index + keyword.length);
  }
  return count;
}

function scoreTitleMatch(title: string, query: string): number {
  const normalizedTitle = title.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;

  const firstIndex = normalizedTitle.indexOf(normalizedQuery);
  if (firstIndex === -1) return Number.NEGATIVE_INFINITY;

  const exactScore = normalizedTitle === normalizedQuery ? 1_000_000 : 0;
  const prefixScore = firstIndex === 0 ? 100_000 : 0;
  const positionScore = Math.max(0, 10_000 - firstIndex * 100);
  const repeatScore = countOccurrences(normalizedTitle, normalizedQuery) * 1_000;
  const coverageScore = Math.round((normalizedQuery.length / Math.max(normalizedTitle.length, 1)) * 100);

  return exactScore + prefixScore + positionScore + repeatScore + coverageScore;
}

function markdownHeadingText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/^#+\s*/g, '').trim() || 'Untitled';
}

function markdownFence(content: string): string {
  const ticks = content.match(/`{3,}/g)?.reduce((max, item) => Math.max(max, item.length), 2) ?? 2;
  return '`'.repeat(ticks + 1);
}

function messagesToMarkdown(session: ConversationSession, messages: ConversationMessage[]): string {
  const lines = [`# ${markdownHeadingText(session.title)}`, '', `- 会话 ID: ${session.id}`, `- 更新时间: ${formatDate(session.updatedAt)}`, ''];
  if (messages.length === 0) {
    lines.push('_未解析到历史消息_', '');
    return lines.join('\n');
  }
  for (const message of messages) {
    const content = message.content || '';
    const fence = markdownFence(content);
    lines.push(`## ${markdownHeadingText(message.role)}`, '', fence, content, fence, '');
  }
  return lines.join('\n');
}

function messagesToText(session: ConversationSession, messages: ConversationMessage[]): string {
  if (messages.length === 0) {
    return `${session.title} (${session.id})\n\n[warn] 未解析到历史消息`;
  }
  return [`${session.title} (${session.id})`, ...messages.map((message) => `[${message.role}] ${message.content}`)].join('\n\n');
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function mergeSessions(current: ConversationSession[], incoming: ConversationSession[]) {
  const map = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) map.set(session.id, session);
  return Array.from(map.values()).toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export default function ConversationPage() {
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [categories, setCategories] = useState<ConversationCategory[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [renameTemplate, setRenameTemplate] = useState('{title}-{idx}');

  const load = useCallback(async (options?: { forceRefresh?: boolean }) => {
    setLoading(true);
    setStatus('');
    try {
      const [sessionList, categoryList] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'LIST_SESSIONS', payload: { forceRefresh: options?.forceRefresh === true } }),
        chrome.runtime.sendMessage({ type: 'GET_CONVERSATION_CATEGORIES' }),
      ]);
      setSessions(mergeSessions([], sessionList ?? []));
      setCategories(categoryList ?? []);
      setSelectedIds(new Set());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '加载会话失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectedSessions = useMemo(
    () => sessions.filter((session) => selectedIds.has(session.id)),
    [sessions, selectedIds],
  );

  const filteredSessions = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = sessions.map((session) => ({
      session,
      score: keyword ? scoreTitleMatch(session.title, keyword) : 0,
    })).filter(({ session, score }) => {
      if (keyword && score === Number.NEGATIVE_INFINITY) return false;
      if (filter === 'all') return true;
      if (filter === 'uncategorized') return !session.categoryIds || session.categoryIds.length === 0;
      return session.categoryIds?.includes(filter) ?? false;
    });
    if (!keyword) return filtered.map(({ session }) => session);
    return filtered
      .toSorted((a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt)
      .map(({ session }) => session);
  }, [filter, query, sessions]);

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => setSelectedIds(new Set(filteredSessions.map((session) => session.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const handleDelete = async (ids: string[]) => {
    if (ids.length === 0) return;
    if (!confirm(`确定删除 ${ids.length} 个对话吗？此操作不可撤销。`)) return;
    setLoading(true);
    try {
      if (ids.length === 1) {
        setStatus('已删除 0/1');
        await chrome.runtime.sendMessage({ type: 'DELETE_SESSION', payload: { id: ids[0] } });
      } else {
        setStatus(`正在删除 ${ids.length} 个对话...`);
        await chrome.runtime.sendMessage({ type: 'DELETE_SESSIONS', payload: { ids } });
      }
      setStatus(`已删除 ${ids.length}/${ids.length}`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '删除失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRename = async (id: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    await chrome.runtime.sendMessage({ type: 'RENAME_SESSION', payload: { id, title: nextTitle } });
    setEditingId(null);
    setEditingTitle('');
    await load();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await chrome.runtime.sendMessage({ type: 'REFRESH_DEEPSEEK_PAGE' });
  };

  const handleBatchRename = async () => {
    if (selectedSessions.length === 0) return;
    if (!confirm(`确定按模板重命名 ${selectedSessions.length} 个对话吗？`)) return;
    setLoading(true);
    try {
      for (let i = 0; i < selectedSessions.length; i++) {
        const session = selectedSessions[i];
        const title = buildRenameTitle(renameTemplate, session, i);
        if (title) {
          setStatus(`重命名 ${i + 1}/${selectedSessions.length}`);
          await chrome.runtime.sendMessage({ type: 'RENAME_SESSION', payload: { id: session.id, title } });
        }
      }
      await load();
      setSelectedIds(new Set());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '批量重命名失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCategory = async () => {
    const name = prompt('分类名称');
    if (!name?.trim()) return;
    const color = CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length];
    const now = Date.now();
    await chrome.runtime.sendMessage({
      type: 'SAVE_CONVERSATION_CATEGORY',
      payload: { id: crypto.randomUUID(), name: name.trim(), color, createdAt: now, sessionIds: [] } satisfies ConversationCategory,
    });
    await load();
  };

  const handleDeleteCategory = async (category: ConversationCategory) => {
    if (!confirm(`确定删除分类「${category.name}」吗？对话本身不会被删除。`)) return;
    await chrome.runtime.sendMessage({ type: 'DELETE_CONVERSATION_CATEGORY', payload: { id: category.id } });
    if (filter === category.id) setFilter('all');
    await load();
  };

  const handleAssignCategory = async (categoryId: string) => {
    if (selectedIds.size === 0) return;
    await chrome.runtime.sendMessage({
      type: 'ASSIGN_SESSIONS_TO_CATEGORY',
      payload: { categoryId, sessionIds: Array.from(selectedIds) },
    });
    await load();
  };

  const handleExport = async (format: ConversationExportFormat) => {
    const targets = selectedSessions.length > 0 ? selectedSessions : filteredSessions.slice(0, 1);
    if (targets.length === 0) return;
    setLoading(true);
    try {
      const exported = [];
      for (let i = 0; i < targets.length; i++) {
        setStatus(`导出 ${i + 1}/${targets.length}`);
        const messages: ConversationMessage[] = await chrome.runtime.sendMessage({ type: 'GET_SESSION_HISTORY', payload: { id: targets[i].id } });
        exported.push({ session: targets[i], messages });
      }
      const date = new Date().toISOString().slice(0, 10);
      if (format === 'json') {
        downloadFile(`deepseek-conversations-${date}.json`, JSON.stringify(exported, null, 2), 'application/json');
      } else if (format === 'md') {
        downloadFile(`deepseek-conversations-${date}.md`, exported.map((item) => messagesToMarkdown(item.session, item.messages)).join('\n\n---\n\n'), 'text/markdown');
      } else {
        downloadFile(`deepseek-conversations-${date}.txt`, exported.map((item) => messagesToText(item.session, item.messages)).join('\n\n---\n\n'), 'text/plain');
      }
      setStatus('导出完成');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '导出失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 space-y-3">
      <div className="sticky top-0 z-10 space-y-3 border-b" style={{ backgroundColor: 'var(--ds-bg)', borderColor: 'var(--ds-border)', margin: '-16px -16px 8px -16px', padding: '12px 16px' }}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>对话管理</h2>
          <button type="button" onClick={() => load({ forceRefresh: true })} disabled={loading} className="ds-btn-secondary px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 disabled:opacity-40">
            {loading ? '加载中' : '刷新'}
          </button>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索对话标题..."
          className="w-full px-3 py-2 text-xs rounded-lg border outline-none transition-colors focus:border-[var(--ds-blue)]"
          style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)', color: 'var(--ds-text)' }}
        />
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button type="button" onClick={() => setFilter('all')} className="shrink-0 px-2.5 py-1 text-xs rounded-full" style={{ background: filter === 'all' ? 'var(--ds-blue-light)' : 'var(--ds-surface)', color: filter === 'all' ? 'var(--ds-blue)' : 'var(--ds-text-secondary)' }}>
            全部({sessions.length})
          </button>
          <button type="button" onClick={() => setFilter('uncategorized')} className="shrink-0 px-2.5 py-1 text-xs rounded-full" style={{ background: filter === 'uncategorized' ? 'var(--ds-blue-light)' : 'var(--ds-surface)', color: filter === 'uncategorized' ? 'var(--ds-blue)' : 'var(--ds-text-secondary)' }}>
            未分类
          </button>
          {categories.map((category) => (
            <span key={category.id} className="inline-flex shrink-0 overflow-hidden rounded-full" style={{ background: filter === category.id ? category.color : 'var(--ds-surface)' }}>
              <button type="button" onClick={() => setFilter(category.id)} className="px-2.5 py-1 text-xs" style={{ color: filter === category.id ? '#fff' : 'var(--ds-text-secondary)' }}>
                {category.name}({category.sessionIds.length})
              </button>
              <button type="button" onClick={() => handleDeleteCategory(category)} className="px-1.5 py-1 text-xs" style={{ color: filter === category.id ? '#fff' : 'var(--ds-text-tertiary)' }}>
                ×
              </button>
            </span>
          ))}
          <button type="button" onClick={handleCreateCategory} className="shrink-0 px-2.5 py-1 text-xs rounded-full" style={{ background: 'var(--ds-surface)', color: 'var(--ds-blue)' }}>+ 新建</button>
        </div>
      </div>

      {status && <div className="text-[11px] px-3 py-2 rounded-lg ds-info-panel" style={{ color: 'var(--ds-text-secondary)' }}>{status}</div>}

      <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--ds-text-tertiary)' }}>
        <span>已选 {selectedIds.size} / 当前 {filteredSessions.length}</span>
        <div className="flex gap-2">
          <button type="button" onClick={selectAllFiltered} className="hover:opacity-80">全选</button>
          <button type="button" onClick={clearSelection} className="hover:opacity-80">清空</button>
        </div>
      </div>

      <div className="space-y-2">
        {filteredSessions.map((session) => (
          <div key={session.id} className="ds-surface-panel rounded-xl p-3 space-y-2">
            <div className="flex items-start gap-2">
              <input type="checkbox" checked={selectedIds.has(session.id)} onChange={() => toggleSelected(session.id)} className="mt-1" />
              <div className="min-w-0 flex-1">
                {editingId === session.id ? (
                  <input
                    value={editingTitle}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onBlur={() => handleRename(session.id, editingTitle)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleRename(session.id, editingTitle);
                      if (event.key === 'Escape') setEditingId(null);
                    }}
                    className="w-full px-2 py-1 text-xs rounded border outline-none"
                    style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)', color: 'var(--ds-text)' }}
                  />
                ) : (
                  <button type="button" onClick={() => { setEditingId(session.id); setEditingTitle(session.title); }} className="block w-full truncate text-left text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
                    {highlightTitle(session.title, query)}
                  </button>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>
                  <span>{formatDate(session.updatedAt)}</span>
                  {session.categoryIds?.map((id) => {
                    const category = categoryById.get(id);
                    if (!category) return null;
                    return <span key={id} className="rounded-full px-1.5 py-0.5 text-white" style={{ background: category.color }}>{category.name}</span>;
                  })}
                </div>
              </div>
                <button type="button" aria-label={`删除 ${session.title}`} title={`删除 ${session.title}`} onClick={() => handleDelete([session.id])} className="p-1.5 rounded-lg transition-colors hover:opacity-80" style={{ color: '#EF4444' }}>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <title>删除</title>
                  <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.trash} />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {!loading && filteredSessions.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-xl" style={{ background: 'var(--ds-surface)' }}>💬</div>
          <p className="text-sm" style={{ color: 'var(--ds-text-tertiary)' }}>未找到匹配的对话</p>
        </div>
      )}

      <div className="sticky bottom-0 space-y-2 rounded-xl border p-3" style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)' }}>
        <div className="flex gap-2">
          <button type="button" disabled={selectedIds.size === 0 || loading} onClick={() => handleDelete(Array.from(selectedIds))} className="ds-btn-danger flex-1 py-2 text-[11px] font-medium rounded-lg disabled:opacity-40">批量删除</button>
          <button type="button" disabled={loading} onClick={() => handleExport('json')} className="ds-btn-secondary flex-1 py-2 text-[11px] font-medium rounded-lg disabled:opacity-40">导出 JSON</button>
          <button type="button" disabled={loading} onClick={() => handleExport('md')} className="ds-btn-secondary flex-1 py-2 text-[11px] font-medium rounded-lg disabled:opacity-40">MD</button>
          <button type="button" disabled={loading} onClick={() => handleExport('txt')} className="ds-btn-secondary flex-1 py-2 text-[11px] font-medium rounded-lg disabled:opacity-40">TXT</button>
        </div>
        <div className="flex gap-2">
          <input value={renameTemplate} onChange={(event) => setRenameTemplate(event.target.value)} className="min-w-0 flex-1 px-3 py-2 text-[11px] rounded-lg border outline-none" style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-border)', color: 'var(--ds-text)' }} />
          <button type="button" disabled={selectedIds.size === 0 || loading} onClick={handleBatchRename} className="ds-btn-secondary px-3 py-2 text-[11px] font-medium rounded-lg disabled:opacity-40">批量重命名</button>
        </div>
        {categories.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto">
            {categories.map((category) => (
              <button key={category.id} type="button" disabled={selectedIds.size === 0 || loading} onClick={() => handleAssignCategory(category.id)} className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-white disabled:opacity-40" style={{ background: category.color }}>
                归类到 {category.name}
              </button>
            ))}
          </div>
        )}
        <div className="text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>
          批量重命名支持 {'{idx}'}、{'{date}'}、{'{time}'}、{'{title}'}。分类仅保存在本地扩展数据中。
        </div>
      </div>
    </div>
  );
}
