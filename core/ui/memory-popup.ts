import type { Memory } from '../types';
import { memoryMatchScore, memoryWeight } from '../weighting';
import { injectStyleElement, popupChromeCss, setNativeTextareaValue } from './popup-common';

let popupEl: HTMLElement | null = null;
let memories: Memory[] = [];
let filtered: Memory[] = [];
let activeIdx = 0;
let textarea: HTMLTextAreaElement | null = null;

let initialized = false;

export function initMemoryPopup(initialMemories: Memory[]) {
  memories = initialMemories;
  if (initialized) return;
  initialized = true;
  injectStyles();
  watchTextarea();
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('mousedown', onClickOutside);
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
}

function onInput() {
  if (!textarea) return;
  const val = textarea.value;

  if (val.startsWith('#') && !val.slice(1).includes(' ')) {
    const query = val.slice(1).toLowerCase();
    filtered = query === ''
      ? sortMemoriesForPopup(memories)
      : sortMemoriesForPopup(memories.filter(
          m =>
            m.name.toLowerCase().includes(query) ||
            m.tags.some(t => t.toLowerCase().includes(query)) ||
            (m.id != null && m.id.toString() === query)
        ), query);
    if (filtered.length > 0) {
      activeIdx = 0;
      showPopup();
      return;
    }
  }
  hidePopup();
}

function sortMemoriesForPopup(items: Memory[], query = ''): Memory[] {
  return [...items].sort((a, b) => (
    memoryWeight(b, memoryMatchScore(b, query)) - memoryWeight(a, memoryMatchScore(a, query)) ||
    b.lastAccessedAt - a.lastAccessedAt ||
    a.name.localeCompare(b.name)
  ));
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
    case 'Enter':
      e.preventDefault();
      e.stopImmediatePropagation();
      selectMemory(filtered[activeIdx]);
      break;
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

function selectMemory(memory: Memory) {
  if (!textarea || !memory) return;

  setNativeTextareaValue(textarea, `#${memory.name} `, '');
  hidePopup();
}

function showPopup() {
  if (!textarea) return;

  if (!popupEl) {
    popupEl = document.createElement('div');
    popupEl.className = 'dpp-memory-popup';
    document.body.appendChild(popupEl);
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
    const item = document.createElement('div');
    item.className = `dpp-memory-item${i === activeIdx ? ' dpp-active' : ''}`;
    item.dataset.i = String(i);

    const head = document.createElement('div');
    head.className = 'dpp-memory-head';

    const trigger = document.createElement('code');
    trigger.className = 'dpp-memory-trigger';
    trigger.textContent = `#${m.name}`;

    const type = document.createElement('span');
    type.className = `dpp-memory-type ${m.type}`;
    type.textContent = m.type;

    const desc = document.createElement('div');
    desc.className = 'dpp-memory-desc';
    desc.textContent = m.content;

    head.append(trigger, type);
    item.append(head, desc);
    item.addEventListener('mouseenter', () => {
      activeIdx = i;
      highlightActive();
    });
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectMemory(filtered[i]);
    });
    container.appendChild(item);
  });

  const hint = document.createElement('div');
  hint.className = 'dpp-memory-hint';
  hint.textContent = '↑↓ 导航 · Enter 选择 · Esc 关闭';
  container.appendChild(hint);
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
