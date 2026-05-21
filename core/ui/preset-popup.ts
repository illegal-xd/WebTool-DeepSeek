import type { SystemPromptPreset } from '../types';

let popupEl: HTMLElement | null = null;
let presets: SystemPromptPreset[] = [];
let filtered: SystemPromptPreset[] = [];
let activeIdx = 0;
let textarea: HTMLTextAreaElement | null = null;

let initialized = false;

export function initPresetPopup(initialPresets: SystemPromptPreset[]) {
  presets = initialPresets;
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

  if (val.startsWith('@') && !val.slice(1).includes(' ')) {
    const query = val.slice(1).toLowerCase();

    // Virtual close preset option
    const closeItem: SystemPromptPreset = {
      id: 'close',
      name: 'close',
      content: '关闭并取消当前激活的系统预设提示词',
      createdAt: 0,
      updatedAt: 0,
    };

    const candidates = [closeItem, ...presets];

    filtered = query === ''
      ? candidates
      : candidates.filter(p => p.name.toLowerCase().includes(query));

    if (filtered.length > 0) {
      activeIdx = 0;
      showPopup();
      return;
    }
  }
  hidePopup();
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
      selectPreset(filtered[activeIdx]);
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

function selectPreset(preset: SystemPromptPreset) {
  if (!textarea || !preset) return;

  const id = preset.id === 'close' ? null : preset.id;
  window.postMessage({
    source: 'WebTool-DeepSeek-main',
    type: 'SET_ACTIVE_PRESET',
    id,
  });

  // Invalidate React's value tracker: set it to the current (non-empty) value
  // so React sees a difference when we clear the DOM value to ''.
  const tracker = (textarea as any)._valueTracker;
  if (tracker) tracker.setValue(textarea.value || '@');

  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value',
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, '');
  } else {
    textarea.value = '';
  }

  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  hidePopup();
}

function showPopup() {
  if (!textarea) return;

  if (!popupEl) {
    popupEl = document.createElement('div');
    popupEl.className = 'dpp-preset-popup';
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

  popupEl.innerHTML = filtered.map((p, i) => `
    <div class="dpp-preset-item${i === activeIdx ? ' dpp-active' : ''}" data-i="${i}">
      <div class="dpp-preset-head">
        <code class="dpp-preset-trigger">@${escapeHtml(p.name)}</code>
        ${p.id === 'close' ? '<span class="dpp-preset-badge close">系统</span>' : '<span class="dpp-preset-badge preset">预设</span>'}
      </div>
      <div class="dpp-preset-desc">${escapeHtml(p.id === 'close' ? p.content : p.content)}</div>
    </div>
  `).join('')
    + '<div class="dpp-preset-hint">↑↓ 导航 · Enter 选择 · Esc 关闭</div>';

  popupEl.querySelectorAll('.dpp-preset-item').forEach(el => {
    const i = parseInt((el as HTMLElement).dataset.i || '0');
    el.addEventListener('mouseenter', () => {
      activeIdx = i;
      highlightActive();
    });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectPreset(filtered[i]);
    });
  });
}

function highlightActive() {
  if (!popupEl) return;
  popupEl.querySelectorAll('.dpp-preset-item').forEach((el, i) => {
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
  if (document.getElementById('dpp-preset-popup-css')) return;
  const style = document.createElement('style');
  style.id = 'dpp-preset-popup-css';
  style.textContent = `
.dpp-preset-popup {
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
.dpp-preset-item {
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background .1s;
}
.dpp-preset-item.dpp-active {
  background: #FFFBEB;
}
.dpp-preset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dpp-preset-trigger {
  color: #D97706;
  font-size: 13px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-weight: 600;
  background: #FFFBEB;
  padding: 1px 6px;
  border-radius: 4px;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dpp-preset-badge {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 500;
}
.dpp-preset-badge.preset {
  color: #D97706;
  background: #FFFBEB;
}
.dpp-preset-badge.close {
  color: #EF4444;
  background: #FEF2F2;
}
.dpp-preset-desc {
  color: #9CA3AF;
  font-size: 11px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dpp-preset-hint {
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
