import { useCallback, useEffect, useState } from 'react';
import type { InjectionEvent, InjectionKind } from '../../../core/inject/events';
import type { TemplateKey, TemplateOverrides } from '../../../core/templates/overrides';
import {
  INSTRUCTION_SEPARATOR,
  MEMORY_BACKGROUND_TEMPLATE,
  SYSTEM_TEMPLATE_CHAT,
  SYSTEM_TEMPLATE_THINKING,
  TOOL_FORMAT_REMINDER_TEMPLATE,
  TOOL_INTRO_LINE,
  TOOL_MUST_FOLLOW_LINE,
  TOOL_SCHEMA_TEMPLATE,
  TOOL_SCHEMAS_HEADING,
  TOOLS_SECTION_HEADING,
  USER_INPUT_PREFIX,
} from '../../../core/templates/prompts';

/** 模板默认值（用户未自定义时显示）。 */
const TEMPLATE_DEFAULTS: Record<TemplateKey, string> = {
  SYSTEM_TEMPLATE_CHAT,
  SYSTEM_TEMPLATE_THINKING,
  USER_INPUT_PREFIX,
  MEMORY_BACKGROUND_TEMPLATE,
  TOOLS_SECTION_HEADING,
  TOOL_INTRO_LINE,
  TOOL_SCHEMAS_HEADING,
  TOOL_MUST_FOLLOW_LINE,
  TOOL_SCHEMA_TEMPLATE,
  TOOL_FORMAT_REMINDER_TEMPLATE,
  INSTRUCTION_SEPARATOR,
};

const KIND_META: Record<InjectionKind, { label: string; color: string; bg: string }> = {
  memory: { label: '记忆', color: 'var(--ds-blue)', bg: 'var(--ds-surface-hover)' },
  preset: { label: '预设', color: 'var(--ds-warning)', bg: 'var(--ds-surface-hover)' },
  prompt: { label: '提示词', color: 'var(--ds-success)', bg: 'var(--ds-surface-hover)' },
  skill: { label: '技能', color: 'var(--ds-purple)', bg: 'var(--ds-surface-hover)' },
  mcp: { label: 'MCP', color: 'var(--ds-danger)', bg: 'var(--ds-surface-hover)' },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === new Date().toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @Deprecated 2026-11 起时间轴改为按会话分组（`groupBySession`）。
 * 保留按天分组实现以便回退；当前渲染不再调用。
 */
function groupByDay(events: InjectionEvent[]): Array<{ label: string; items: InjectionEvent[] }> {
  const dayMap = new Map<string, { label: string; items: InjectionEvent[] }>();
  for (const event of events) {
    const d = new Date(event.ts);
    const today = new Date();
    let label: string;
    if (d.toDateString() === today.toDateString()) label = '今天';
    else {
      const yesterday = new Date(today.getTime() - 86_400_000);
      label = d.toDateString() === yesterday.toDateString() ? '昨天' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const group = dayMap.get(label) ?? { label, items: [] };
    group.items.push(event);
    dayMap.set(label, group);
  }
  return [...dayMap.values()].sort((a, b) => (a.items[0].ts > b.items[0].ts ? -1 : 1));
}

const UNBOUND_SESSION_KEY = '__unbound_session__';

interface SessionGroup {
  key: string;
  items: InjectionEvent[];
  latest: number;
}

/** 同一会话的注入事件收拢为一组（组内按时间倒序，组间按最近活动倒序）。 */
function groupBySession(events: InjectionEvent[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const event of events) {
    const key = event.sessionId?.trim() || UNBOUND_SESSION_KEY;
    const group = map.get(key) ?? { key, items: [], latest: 0 };
    group.items.push(event);
    group.latest = Math.max(group.latest, event.ts);
    map.set(key, group);
  }
  return [...map.values()]
    .map((group) => ({ ...group, items: group.items.toSorted((a, b) => b.ts - a.ts) }))
    .toSorted((a, b) => b.latest - a.latest);
}

function sessionLabel(key: string): string {
  if (key === UNBOUND_SESSION_KEY) return '未关联会话';
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** 标题前缀（如「技能注入：」）已由左侧彩色类型标签表达，这里剥离避免一行内重复。 */
function compactTitle(title: string, kindLabel: string): string {
  const colonPrefix = `${kindLabel}注入：`;
  if (title.startsWith(colonPrefix)) return title.slice(colonPrefix.length);
  if (title === `${kindLabel}注入`) return '';
  return title;
}

export default function InjectPage() {
  const [events, setEvents] = useState<InjectionEvent[]>([]);
  const [view, setView] = useState<'timeline' | 'templates'>('timeline');
  const [tab, setTab] = useState<TemplateKey>('SYSTEM_TEMPLATE_CHAT');
  const [overrides, setOverrides] = useState<TemplateOverrides>({});

  const sendTestEvent = async () => {
    const event: InjectionEvent = {
      id: Date.now(),
      ts: Date.now(),
      kind: 'prompt',
      title: '测试注入事件（链路自检）',
      detail: '若此条显示，说明注入事件链路正常',
    };
    await chrome.runtime.sendMessage({ type: 'RECORD_INJECTION_EVENT', payload: event });
    await loadEvents();
  };

  const loadEvents = useCallback(async () => {
    const list = await chrome.runtime.sendMessage({ type: 'GET_INJECTION_EVENTS' }) as InjectionEvent[] | null;
    setEvents(list ?? []);
  }, []);

  const loadOverrides = useCallback(async () => {
    const list = await chrome.runtime.sendMessage({ type: 'GET_TEMPLATE_OVERRIDES' }) as TemplateOverrides | null;
    setOverrides(list ?? {});
  }, []);

  useEffect(() => {
    void loadEvents();
    void loadOverrides();
    const listener = (msg: { type?: string }) => {
      if (msg.type === 'INJECTION_EVENTS_UPDATED') void loadEvents();
      if (msg.type === 'TEMPLATES_UPDATED') void loadOverrides();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [loadEvents, loadOverrides]);

  const handleSaveTemplate = async (key: TemplateKey, value: string) => {
    const next = { ...overrides };
    if (!value.trim()) delete next[key];
    else next[key] = value;
    const resp = await chrome.runtime.sendMessage({ type: 'SET_TEMPLATE_OVERRIDES', payload: next });
    if (resp?.ok) setOverrides(next);
  };

  const handleResetTemplate = async (key: TemplateKey) => {
    const next = { ...overrides };
    delete next[key];
    const resp = await chrome.runtime.sendMessage({ type: 'SET_TEMPLATE_OVERRIDES', payload: next });
    if (resp?.ok) setOverrides(next);
  };

  return (
    <div className="p-4 space-y-4">
      <section className="ds-surface-panel rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold" style={{ color: 'var(--ds-text)' }}>注入</h2>
            <p className="text-[12px] mt-1 text-[var(--ds-text-secondary)]">记忆 / 预设 / 提示词注入动态</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={view === 'timeline' ? 'ds-btn-primary px-3 py-1.5 text-xs font-medium rounded-lg text-white' : 'ds-btn-secondary px-3 py-1.5 text-xs font-medium rounded-lg'}
              onClick={() => setView('timeline')}
            >时间轴</button>
            <button
              type="button"
              className={view === 'templates' ? 'ds-btn-primary px-3 py-1.5 text-xs font-medium rounded-lg text-white' : 'ds-btn-secondary px-3 py-1.5 text-xs font-medium rounded-lg'}
              onClick={() => setView('templates')}
            >模板编辑器</button>
            <button
              type="button"
              className="ds-btn-cancel px-3 py-1.5 text-xs font-medium rounded-lg"
              onClick={() => void sendTestEvent()}
              title="发送一条测试注入事件，验证时间轴链路"
            >测试事件</button>
          </div>
        </div>
      </section>

      {view === 'timeline' && (
        <>
          {events.length === 0 && (
            <div className="ds-card rounded-2xl p-6 text-center text-[13px] text-[var(--ds-text-tertiary)]">
              暂无注入记录。开始与 DeepSeek 对话后，记忆/预设/提示词注入事件将在此展示。
            </div>
          )}
          {events.length > 0 && (
            <div className="space-y-3">
              {groupBySession(events).map((group, index) => (
                <SessionGroupCard key={group.key} group={group} defaultOpen={index === 0} />
              ))}

              <div className="flex justify-end">
                <button
                  type="button"
                  className="ds-btn-cancel px-3 py-1.5 text-xs font-medium rounded-lg"
                  onClick={async () => {
                    if (!confirm('清空所有注入记录？')) return;
                    await chrome.runtime.sendMessage({ type: 'CLEAR_INJECTION_EVENTS' });
                    await loadEvents();
                  }}
                >清空记录</button>
              </div>
            </div>
          )}
        </>
      )}

      {view === 'templates' && (
        <TemplateEditor
          activeTab={tab}
          onTabChange={setTab}
          overrides={overrides}
          onSave={handleSaveTemplate}
          onReset={handleResetTemplate}
        />
      )}
    </div>
  );
}

function TemplateEditor(props: {
  activeTab: TemplateKey;
  onTabChange: (key: TemplateKey) => void;
  overrides: TemplateOverrides;
  onSave: (key: TemplateKey, value: string) => void;
  onReset: (key: TemplateKey) => void;
}) {
  const { activeTab, onTabChange, overrides, onSave, onReset } = props;
  const [edit, setEdit] = useState<TemplateKey | null>(null);
  const [value, setValue] = useState('');

  const overridden = typeof overrides[activeTab] === 'string';
  const defaultValue = TEMPLATE_DEFAULTS[activeTab] ?? '';
  // 已自定义则显示覆盖值，否则显示默认模板内容。
  const currentValue = overridden ? overrides[activeTab]! : defaultValue;

  const startEdit = () => {
    // 编辑始终带回默认值（未自定义时：默认值作为编辑基线）
    setValue(currentValue);
    setEdit(activeTab);
  };

  const saveEdit = () => {
    if (!edit) return;
    onSave(edit, value);
    setEdit(null);
  };

  return (
    <div className="space-y-3">
      <section className="ds-card rounded-2xl p-4">
        <div className="text-[12px] font-medium mb-2 text-[var(--ds-text-secondary)]">模板选择</div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries({
            SYSTEM_TEMPLATE_CHAT: '系统模板',
            SYSTEM_TEMPLATE_THINKING: '思考模板',
            USER_INPUT_PREFIX: '用户输入（已弃用）',
            MEMORY_BACKGROUND_TEMPLATE: '记忆包装',
            TOOLS_SECTION_HEADING: '工具标题',
            TOOL_INTRO_LINE: '工具导语',
            TOOL_SCHEMAS_HEADING: 'Schema 标题',
            TOOL_MUST_FOLLOW_LINE: '调用约束',
            TOOL_SCHEMA_TEMPLATE: 'Schema 模板',
            TOOL_FORMAT_REMINDER_TEMPLATE: '格式提醒',
            INSTRUCTION_SEPARATOR: '分隔符',
          } as Record<TemplateKey, string>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => { onTabChange(key as TemplateKey); setEdit(null); }}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors"
              style={{
                background: activeTab === key ? 'var(--ds-blue)' : 'var(--ds-surface)',
                color: activeTab === key ? 'white' : 'var(--ds-text-secondary)',
              }}
            >{typeof overrides[key as TemplateKey] === 'string' ? `${label} *` : label}</button>
          ))}
        </div>
      </section>

      <section className="ds-card rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold text-[var(--ds-text)]">{overridden ? '已自定义模板' : '默认模板'}</div>
          <div className="flex gap-2">
            {edit !== activeTab && overridden && (
              <button type="button" className="ds-btn-cancel px-3 py-1.5 text-xs rounded-lg" onClick={() => onReset(activeTab)}>恢复默认</button>
            )}
            {edit !== activeTab && (
              <button type="button" className="ds-btn-primary px-3 py-1.5 text-xs rounded-lg text-white" onClick={startEdit}>编辑</button>
            )}
          </div>
        </div>
        {edit === activeTab && (
          <>
            <div className="text-[11px] text-[var(--ds-text-tertiary)]">修改后点击保存；留空则该模板恢复默认。</div>
            <textarea
              className="ds-input mt-1 w-full rounded-xl px-3 py-2 text-[12px] font-mono min-h-[180px] leading-relaxed"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="在此输入自定义模板内容（留空恢复默认）…"
            />
            <div className="flex gap-2 justify-end">
              <button type="button" className="ds-btn-cancel px-3.5 py-1.5 text-xs rounded-lg" onClick={() => setEdit(null)}>取消</button>
              <button type="button" className="ds-btn-primary px-4 py-1.5 text-xs rounded-lg text-white" onClick={saveEdit}>保存</button>
            </div>
          </>
        )}
        {edit !== activeTab && (
          <div className="text-[12px] whitespace-pre-wrap break-words leading-relaxed text-[var(--ds-text-secondary)]" style={{ maxHeight: 320, overflowY: 'auto' }}>
            {currentValue || '(空模板)'}
          </div>
        )}
      </section>
    </div>
  );
}

/** 会话卡片：头部折叠整组，内部每条注入事件仍可单独展开注入数据。 */
function SessionGroupCard(props: { group: SessionGroup; defaultOpen: boolean }) {
  const { group, defaultOpen } = props;
  const [open, setOpen] = useState(defaultOpen);
  const isUnbound = group.key === UNBOUND_SESSION_KEY;

  return (
    <div className="ds-card rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors"
        style={{ background: open ? 'var(--ds-surface)' : 'transparent' }}
        aria-expanded={open}
        title={isUnbound ? '未关联会话的注入记录' : group.key}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: isUnbound ? 'var(--ds-text-tertiary)' : 'var(--ds-blue)' }}
        />
        <span className="text-[12px] font-medium truncate min-w-0" style={{ color: 'var(--ds-text)' }}>
          {isUnbound ? '未关联会话' : `会话 ${sessionLabel(group.key)}`}
        </span>
        <span className="text-[10px] shrink-0" style={{ color: 'var(--ds-text-tertiary)' }}>
          | {group.items.length} 次注入
        </span>
        <span className="ml-auto text-[10px] shrink-0 tabular-nums" style={{ color: 'var(--ds-text-tertiary)' }}>
          {formatTime(group.latest)}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            color: 'var(--ds-text-tertiary)',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.2s',
            flexShrink: 0,
          }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {open && (
        <div className="px-1.5 pb-1.5 space-y-0.5">
          {group.items.map((event) => (
            <InjectionEventCard key={event.id} event={event} meta={KIND_META[event.kind]} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 单条注入事件：类型标签 | 主标题 | 描述 | 时间 一行展示（各自保留主题色），
 * 点击本行仅展开/收起该条的注入数据，不影响所在会话卡片的折叠状态。
 */
function InjectionEventCard(props: {
  event: InjectionEvent;
  meta: { label: string; color: string; bg: string };
}) {
  const { event, meta } = props;
  const [expanded, setExpanded] = useState(false);
  const hasPayload = Boolean(event.payload && event.payload.trim());
  const title = compactTitle(event.title, meta.label);

  return (
    <div className="rounded-xl transition-colors" style={{ background: expanded ? 'var(--ds-surface-hover)' : 'transparent' }}>
      <div
        role={hasPayload ? 'button' : undefined}
        tabIndex={hasPayload ? 0 : undefined}
        onClick={() => hasPayload && setExpanded((value) => !value)}
        onKeyDown={(e) => {
          if (hasPayload && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setExpanded((value) => !value);
          }
        }}
        className="flex items-center gap-1.5 px-2.5 py-1.5 w-full min-w-0"
        style={{ cursor: hasPayload ? 'pointer' : 'default' }}
        title={event.detail ? `${event.title} · ${event.detail}` : event.title}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: meta.color }} />
        <span className="text-[11px] font-medium shrink-0" style={{ color: meta.color }}>
          {meta.label}
        </span>
        {title && (
          <>
            <span className="text-[10px] shrink-0" style={{ color: 'var(--ds-border-strong, #D1D5DB)' }}>|</span>
            <span className="text-[12px] truncate min-w-0" style={{ color: 'var(--ds-text)', flexShrink: 2 }}>{title}</span>
          </>
        )}
        {event.detail && (
          <>
            <span className="text-[10px] shrink-0" style={{ color: 'var(--ds-border-strong, #D1D5DB)' }}>|</span>
            <span className="text-[11px] truncate min-w-0" style={{ color: 'var(--ds-text-secondary)' }}>
              {event.detail}
            </span>
          </>
        )}
        <span className="ml-auto text-[10px] shrink-0 tabular-nums" style={{ color: 'var(--ds-text-tertiary)' }}>
          {formatTime(event.ts)}
        </span>
        {hasPayload && (
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              color: 'var(--ds-text-tertiary)',
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.2s',
              flexShrink: 0,
            }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        )}
      </div>
      {expanded && hasPayload && (
        <pre
          className="mx-2.5 mb-2 p-2.5 rounded-lg text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words overflow-auto"
          style={{
            background: 'var(--ds-bg)',
            color: 'var(--ds-text-secondary)',
            maxHeight: 400,
            overflowWrap: 'anywhere',
            overscrollBehavior: 'contain',
          }}
        >
          {event.payload}
        </pre>
      )}
    </div>
  );
}
