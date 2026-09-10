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
              {groupByDay(events).map((group) => (
                <div key={group.label}>
                  <div className="text-[12px] font-medium text-[var(--ds-text-secondary)] mb-2 flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full text-[10px] bg-[var(--ds-surface)]">{group.label}</span>
                    <span className="text-[10px] text-[var(--ds-text-tertiary)]">{group.items.length} 次注入</span>
                  </div>
                  <div className="space-y-2 pl-2 border-l-2 border-[var(--ds-border)]">
                    {group.items.map((event) => {
                      const meta = KIND_META[event.kind];
                      return <InjectionEventCard key={event.id} event={event} meta={meta} />;
                    })}
                  </div>
                </div>
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

/** 注入事件卡片：支持折叠/展开查看全量注入数据。 */
function InjectionEventCard(props: {
  event: InjectionEvent;
  meta: { label: string; color: string; bg: string };
}) {
  const { event, meta } = props;
  const [expanded, setExpanded] = useState(false);
  const hasPayload = Boolean(event.payload && event.payload.trim());

  return (
    <div className="ds-card rounded-2xl p-3 relative ml-2">
      <div
        role={hasPayload ? 'button' : undefined}
        tabIndex={hasPayload ? 0 : undefined}
        className="flex items-start gap-2 w-full text-left"
        onClick={() => hasPayload && setExpanded((v) => !v)}
        onKeyDown={(e) => { if (hasPayload && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setExpanded((v) => !v); } }}
        style={{ cursor: hasPayload ? 'pointer' : 'default' }}
      >
        <div className="mt-1 w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 justify-between">
            <span className="text-[11px] font-medium" style={{ color: meta.color }}>{meta.label}注入</span>
            <span className="text-[10px] text-[var(--ds-text-tertiary)] shrink-0">{formatTime(event.ts)}</span>
          </div>
          <div className="text-[13px] mt-1 break-words" style={{ color: 'var(--ds-text)' }}>{event.title}</div>
          {event.detail && <div className="text-[11px] mt-1 break-words" style={{ color: 'var(--ds-text-secondary)' }}>{event.detail}</div>}
          {event.sessionId && <div className="text-[10px] mt-1 truncate" style={{ color: 'var(--ds-text-tertiary)' }}>会话: {event.sessionId}</div>}
          {hasPayload && (
            <div className="text-[10px] mt-1.5 flex items-center gap-1" style={{ color: 'var(--ds-text-tertiary)' }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}><polyline points="9 18 15 12 9 6" /></svg>
              <span>{expanded ? '收起注入数据' : '展开查看全量注入数据'}</span>
              <span className="text-[9px]">({event.payload!.length} 字符)</span>
            </div>
          )}
        </div>
      </div>
      {expanded && hasPayload && (
        <pre className="mt-2 ml-4 p-2.5 rounded-xl text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words overflow-auto" style={{
          background: 'var(--ds-surface)',
          color: 'var(--ds-text-secondary)',
          maxHeight: 400,
          overflowWrap: 'anywhere',
          overscrollBehavior: 'contain',
        }}>{event.payload}</pre>
      )}
    </div>
  );
}
