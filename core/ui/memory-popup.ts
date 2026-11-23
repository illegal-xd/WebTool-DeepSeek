import type { Memory } from '../types';
import { memoryMatchScore, memoryWeight } from '../weighting';
import { getInjectedMemoryIdsForContext, matchLeadingMemory } from '../interceptor/fetch-hook';
import { injectStyleElement, popupChromeCss, setNativeTextareaValue } from './popup-common';

let popupEl: HTMLElement | null = null;
let memories: Memory[] = [];
let filtered: Memory[] = [];
let activeIdx = 0;
let textarea: HTMLTextAreaElement | null = null;
/** 当前对话上下文已注入的记忆：仍展示，但不可再选择。 */
let injectedIds = new Set<number>();
/** 输入框开头 `#记忆名` 序列中已写入的记忆：仍展示，但不可重复选择。 */
let selectedIds = new Set<number>();
let selectedNames = new Set<string>();

let initialized = false;

/** 开头 `#记忆名` 序列的解析上限（与发送端 `MAX_MEMORY_COMMAND_ENTRIES` 一致）。 */
const MAX_TOKENS = 20;

/**
 * `#` 记忆弹窗：把记忆触发词插入输入框，支持一次输入多条。
 *
 * - 静默注入的记忆不在此列表展示（它由发送时的自动注入负责，不需要手动选择）
 * - 已注入的记忆展示为「已注入」并禁止选择（内容已在上下文里）
 * - 输入框中已写入的记忆展示为「已选」并禁止重复选择
 * - 只有位于消息开头连续 `#记忆名` 序列之后的 `#` 才触发：发送端
 *   `parseMemoryCommand` 只解析输入开头的 `#` 序列，正文中间的 `#` 不会注入
 */
export function initMemoryPopup(initialMemories: Memory[]) {
  memories = initialMemories;
  if (initialized) return;
  initialized = true;
  injectStyles();
  watchTextarea();
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('mousedown', onClickOutside);
}

/** 记忆列表变化时同步（SYNC_STATE / MEMORY_CONFIG_UPDATED）。 */
export function updateMemoryPopupConfig(options: { memories?: Memory[] }) {
  if (!options.memories) return;
  memories = options.memories;
}

function isInjected(memory: Memory): boolean {
  return memory.id != null && injectedIds.has(memory.id);
}

function isSelected(memory: Memory): boolean {
  return (memory.id != null && selectedIds.has(memory.id)) || selectedNames.has(memory.name.toLowerCase());
}

/** 已选/已注入的记忆不可再次选择（避免输入框出现重复触发词或重复注入）。 */
function isUnavailable(memory: Memory): boolean {
  return isSelected(memory) || isInjected(memory);
}

function watchTextarea() {
  tryAttach();
  new MutationObserver(() => {
    if (!textarea || !document.contains(textarea)) {
      textarea = null;
      tryAttach();
    }
  }).observe(document.body, { childList: true, subtree: true });
}

function tryAttach() {
  if (textarea) return;
  const el = document.querySelector<HTMLTextAreaElement>('textarea#chat-input')
    || document.querySelector<HTMLTextAreaElement>('textarea');
  if (!el) return;
  textarea = el;
  el.addEventListener('input', onInput);
  el.addEventListener('blur', onBlur);
  el.addEventListener('keydown', onTextareaKeydown);
}

function onInput() {
  if (!textarea) return;
  const value = textarea.value;
  const token = findHashToken(value, textarea.selectionStart ?? value.length);

  if (token) {
    const query = token.query.toLowerCase();
    // 先同步「输入框中已选」状态，供排序与禁用判断使用。
    const selected = collectSelectedMemories(value);
    selectedIds = selected.ids;
    selectedNames = selected.names;
    // 静默注入的记忆不属于手动选择范围：直接从候选中剔除。
    const selectable = memories.filter((memory) => memory.silentInject !== true);
    filtered = query === ''
      ? sortMemoriesForPopup(selectable)
      : sortMemoriesForPopup(selectable.filter(
          m =>
            m.name.toLowerCase().includes(query) ||
            m.tags.some(t => t.toLowerCase().includes(query)) ||
            (m.id != null && m.id.toString() === query)
        ), query);
    if (filtered.length > 0) {
      // 已选/已注入项排到末尾，默认高亮与回车优先落在可选项上。
      filtered.sort((a, b) => Number(isUnavailable(a)) - Number(isUnavailable(b)));
      activeIdx = 0;
      showPopup();
      return;
    }
  }
  hidePopup();
}

/**
 * 光标所在的 `#` 触发片段。
 *
 * 仅接受「输入开头连续 `#记忆名` 序列之后」的位置：发送端只解析开头的 `#` 序列，
 * 正文中间的 `#` 不会产生注入，因此不弹窗误导用户。
 */
function findHashToken(value: string, caret: number): { start: number; end: number; query: string } | null {
  let start = caret - 1;
  for (; start >= 0; start -= 1) {
    const ch = value[start];
    if (ch === '#' || /\s/.test(ch)) break;
  }
  if (start < 0 || value[start] !== '#') return null;
  if (!isMemoryPrefix(value.slice(0, start))) return null;

  let end = caret;
  while (end < value.length && value[end] !== '#' && !/\s/.test(value[end])) end += 1;
  return { start, end, query: value.slice(start + 1, caret) };
}

/** 文本是否完全由开头连续 `#记忆名` + 空白组成（解析规则与发送端一致）。 */
function isMemoryPrefix(text: string): boolean {
  const sorted = sortByLongestName(memories);
  let rest = text;
  for (let guard = 0; guard < MAX_TOKENS; guard += 1) {
    const parsed = matchLeadingMemory(rest, sorted);
    if (!parsed) break;
    rest = parsed.rest;
    if (!rest.startsWith('#')) break;
  }
  return rest.trim() === '';
}

/** 收集输入框开头 `#记忆名` 序列中已写入的记忆。 */
function collectSelectedMemories(text: string): { ids: Set<number>; names: Set<string> } {
  const sorted = sortByLongestName(memories);
  const ids = new Set<number>();
  const names = new Set<string>();
  let rest = text;
  for (let guard = 0; guard < MAX_TOKENS; guard += 1) {
    const parsed = matchLeadingMemory(rest, sorted);
    if (!parsed) break;
    if (parsed.memory.id != null) ids.add(parsed.memory.id);
    names.add(parsed.memory.name.toLowerCase());
    rest = parsed.rest;
    if (!rest.startsWith('#')) break;
  }
  return { ids, names };
}

function sortByLongestName(items: Memory[]): Memory[] {
  return [...items].sort((a, b) => b.name.length - a.name.length);
}

function sortMemoriesForPopup(items: Memory[], query = ''): Memory[] {
  return [...items].sort((a, b) => (
    memoryWeight(b, memoryMatchScore(b, query)) - memoryWeight(a, memoryMatchScore(a, query)) ||
    b.lastAccessedAt - a.lastAccessedAt ||
    a.name.localeCompare(b.name)
  ));
}

function onTextareaKeydown(e: KeyboardEvent) {
  // 回车发送：弹窗不再拦截，先收起再让 DeepSeek 正常发送。
  if (e.key === 'Enter' && !e.shiftKey && isVisible()) {
    hidePopup();
  }
}

function onBlur() {
  window.setTimeout(() => {
    if (!isVisible()) return;
    const active = document.activeElement;
    if (active === textarea) return;
    if (active && popupEl?.contains(active)) return;
    hidePopup();
  }, 120);
}

function onKeydown(e: KeyboardEvent) {
  if (!isVisible()) return;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      e.stopImmediatePropagation();
      activeIdx = (activeIdx + 1) % filtered.length;
      highlightActive();
      break;
    case 'ArrowUp':
      e.preventDefault();
      e.stopImmediatePropagation();
      activeIdx = (activeIdx - 1 + filtered.length) % filtered.length;
      highlightActive();
      break;
    case 'Tab':
    case 'Enter': {
      const target = filtered[activeIdx];
      // 已选/已注入项不能再选：关闭弹窗并把输入框还给用户。
      if (!target || isUnavailable(target)) {
        hidePopup();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      selectMemory(target);
      break;
    }
    case 'Escape':
      e.preventDefault();
      e.stopImmediatePropagation();
      hidePopup();
      break;
  }
}

function onClickOutside(e: MouseEvent) {
  if (!isVisible()) return;
  if (popupEl?.contains(e.target as Node)) return;
  if (e.target === textarea) return;
  hidePopup();
}

/** 把选中的记忆触发词插入光标所在的 `#` 片段位置，其余正文保持不变。 */
function selectMemory(memory: Memory) {
  if (!textarea || !memory) return;
  const value = textarea.value;
  const caret = textarea.selectionStart ?? value.length;
  const token = findHashToken(value, caret);
  if (!token) return;

  const snippet = `#${memory.name} `;
  const next = value.slice(0, token.start) + snippet + value.slice(token.end);
  // 先收起，避免 setNativeTextareaValue 派发的 input 事件重新打开弹窗。
  hidePopup();
  setNativeTextareaValue(textarea, next, value);
  const caretAfter = token.start + snippet.length;
  textarea.setSelectionRange(caretAfter, caretAfter);
  hidePopup();
}

function showPopup() {
  if (!textarea) return;

  injectedIds = new Set(getInjectedMemoryIdsForContext());
  const selected = collectSelectedMemories(textarea.value);
  selectedIds = selected.ids;
  selectedNames = selected.names;

  if (!popupEl) {
    popupEl = document.createElement('div');
    popupEl.className = 'dpp-memory-popup';
    (document.body ?? document.documentElement)?.appendChild(popupEl);
  }

  const rect = textarea.getBoundingClientRect();
  Object.assign(popupEl.style, {
    display: 'block',
    left: `${rect.left}px`,
    bottom: `${window.innerHeight - rect.top + 6}px`,
    width: `${Math.min(rect.width * 0.5, 280)}px`,
  });

  buildItems();
}

function buildItems() {
  if (!popupEl) return;
  const container = popupEl;

  container.textContent = '';

  filtered.forEach((m, i) => {
    const selected = isSelected(m);
    const injected = isInjected(m);
    const unavailable = selected || injected;
    const item = document.createElement('div');
    item.className = `dpp-memory-item${i === activeIdx ? ' dpp-active' : ''}${unavailable ? ' is-disabled' : ''}`;
    item.dataset.i = String(i);

    const head = document.createElement('div');
    head.className = 'dpp-memory-head';

    const trigger = document.createElement('code');
    trigger.className = 'dpp-memory-trigger';
    trigger.textContent = `#${m.name}`;

    const tail = document.createElement('span');
    tail.className = 'dpp-memory-tail';

    const type = document.createElement('span');
    type.className = `dpp-memory-type ${m.type}`;
    type.textContent = m.type;
    tail.appendChild(type);

    if (selected) {
      const badge = document.createElement('span');
      badge.className = 'dpp-memory-injected';
      badge.textContent = '已选';
      badge.title = '该记忆已在输入框中，无需重复选择';
      tail.appendChild(badge);
    } else if (injected) {
      const badge = document.createElement('span');
      badge.className = 'dpp-memory-injected';
      badge.textContent = '已注入';
      badge.title = '该记忆已在本对话上下文中，模型可直接读取，无需重复注入';
      tail.appendChild(badge);
    }

    const desc = document.createElement('div');
    desc.className = 'dpp-memory-desc';
    desc.textContent = m.content;

    head.append(trigger, tail);
    item.append(head, desc);

    item.addEventListener('mouseenter', () => {
      activeIdx = i;
      highlightActive();
    });
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!filtered[i] || isUnavailable(filtered[i])) return;
      selectMemory(filtered[i]);
    });
    container.appendChild(item);
  });

  const hint = document.createElement('div');
  hint.className = 'dpp-memory-hint';
  hint.textContent = '↑↓ 导航 · Enter 选择 · Esc 关闭 · 可连续选择多条，已选/已注入项不可重复选择';
  container.appendChild(hint);

  highlightActive();
}

function highlightActive() {
  if (!popupEl) return;
  popupEl.querySelectorAll('.dpp-memory-item').forEach((el, i) => {
    el.classList.toggle('dpp-active', i === activeIdx);
    if (i === activeIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function hidePopup() {
  if (popupEl) popupEl.style.display = 'none';
}

function isVisible() {
  return popupEl !== null && popupEl.style.display !== 'none';
}

function injectStyles() {
  injectStyleElement('dpp-memory-popup-css', `
${popupChromeCss('memory', 'var(--dpp-memory-bg, #F5F3FF)')}
.dpp-memory-item.is-disabled {
  opacity: .62;
  cursor: default;
}
.dpp-memory-item.is-disabled:hover { background: transparent; }
.dpp-memory-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dpp-memory-trigger {
  color: var(--dpp-memory-color, #8B5CF6);
  font-size: 13px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-weight: 600;
  background: var(--dpp-memory-bg, #F5F3FF);
  padding: 1px 6px;
  border-radius: 4px;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dpp-memory-tail {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.dpp-memory-type {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 500;
}
.dpp-memory-type.user {
  color: var(--dpp-info-color, #3B82F6);
  background: var(--dpp-info-bg, #EFF6FF);
}
.dpp-memory-type.feedback {
  color: var(--dpp-danger-color, #EF4444);
  background: var(--dpp-danger-bg, #FEF2F2);
}
.dpp-memory-type.topic {
  color: var(--dpp-success-color, #10B981);
  background: var(--dpp-success-bg, #ECFDF5);
}
.dpp-memory-type.reference {
  color: var(--dpp-reference-color, #F59E0B);
  background: var(--dpp-reference-bg, #FFFBEB);
}
.dpp-memory-desc {
  color: var(--dpp-prompt-text-muted, #9CA3AF);
  font-size: 11px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dpp-memory-injected {
  font-size: 10px;
  line-height: 1.4;
  padding: 1px 5px;
  border-radius: 999px;
  white-space: nowrap;
  color: var(--dpp-prompt-text-muted, #6B7280);
  background: var(--dpp-prompt-hint-border, #F3F4F6);
  border: 1px solid var(--dpp-prompt-border, #E5E7EB);
}
.dpp-memory-hint {
  text-align: center;
  color: var(--dpp-prompt-text-faint, #D1D5DB);
  font-size: 10px;
  padding: 4px 0 2px;
  border-top: 1px solid var(--dpp-prompt-hint-border, #F3F4F6);
  margin-top: 4px;
}
`);
}
