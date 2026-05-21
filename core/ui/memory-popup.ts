import type { Memory } from '../types';
import { memoryWeight } from '../weighting';

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

function memoryPopupMatchScore(memory: Memory, query: string): number {
  if (!query) return 0;
  const name = memory.name.toLowerCase();
  if (name === query) return 1000;
  if (name.startsWith(query)) return 600;
  if (name.includes(query)) return 300;
  if (memory.tags.some((tag) => tag.toLowerCase().includes(query))) return 180;
  if (memory.id != null && memory.id.toString() === query) return 900;
  return 0;
}

function sortMemoriesForPopup(items: Memory[], query = ''): Memory[] {
  return [...items].sort((a, b) => (
    memoryWeight(b, memoryPopupMatchScore(b, query)) - memoryWeight(a, memoryPopupMatchScore(a, query)) ||
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

  const newVal = `#${memory.name} `;

  // Invalidate React's value tracker so it detects the change
  const tracker = (textarea as any)._valueTracker;
  if (tracker) tracker.setValue('');

  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value',
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, newVal);
  } else {
    textarea.value = newVal;
  }

  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(newVal.length, newVal.length);
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

  popupEl.innerHTML = filtered.map((m, i) => `
    <div class="dpp-memory-item${i === activeIdx ? ' dpp-active' : ''}" data-i="${i}">
      <div class="dpp-memory-head">
        <code class="dpp-memory-trigger">#${escapeHtml(m.name)}</code>
        <span class="dpp-memory-type ${escapeHtml(m.type)}">${escapeHtml(m.type)}</span>
      </div>
      <div class="dpp-memory-desc">${escapeHtml(m.content)}</div>
    </div>
  `).join('')
    + '<div class="dpp-memory-hint">↑↓ 导航 · Enter 选择 · Esc 关闭</div>';

  popupEl.querySelectorAll('.dpp-memory-item').forEach(el => {
    const i = parseInt((el as HTMLElement).dataset.i || '0');
    el.addEventListener('mouseenter', () => {
      activeIdx = i;
      highlightActive();
    });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectMemory(filtered[i]);
    });
  });
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

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function injectStyles() {
  if (document.getElementById('dpp-memory-popup-css')) return;
  const style = document.createElement('style');
  style.id = 'dpp-memory-popup-css';
  style.textContent = `
.dpp-memory-popup {
  position: fixed;
  z-index: 99999;
  background: #FFFFFF;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 4px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04);
  display: none;
  animation: dpp-slide-up .15s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
  backdrop-filter: blur(8px);
  max-height: 220px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
@keyframes dpp-slide-up {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.dpp-memory-item {
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background .1s;
}
.dpp-memory-item.dpp-active {
  background: #F5F3FF;
}
.dpp-memory-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dpp-memory-trigger {
  color: #8B5CF6;
  font-size: 13px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-weight: 600;
  background: #F5F3FF;
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
  color: #3B82F6;
  background: #EFF6FF;
}
.dpp-memory-type.feedback {
  color: #EF4444;
  background: #FEF2F2;
}
.dpp-memory-type.topic {
  color: #10B981;
  background: #ECFDF5;
}
.dpp-memory-type.reference {
  color: #F59E0B;
  background: #FFFBEB;
}
.dpp-memory-desc {
  color: #9CA3AF;
  font-size: 11px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dpp-memory-hint {
  text-align: center;
  color: #D1D5DB;
  font-size: 10px;
  padding: 4px 0 2px;
  border-top: 1px solid #F3F4F6;
  margin-top: 4px;
}
`;
  document.head.appendChild(style);
}
