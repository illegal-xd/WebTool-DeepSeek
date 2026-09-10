import type { SystemPromptPreset } from '../types';
import { sortPresetsByWeight } from '../weighting';
import { injectStyleElement, popupChromeCss, setNativeTextareaValue } from './popup-common';

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
    filtered = query === ''
      ? sortPresetsByWeight(presets)
      : sortPresetsByWeight(
          presets.filter(p => p.name.toLowerCase().includes(query)),
          query,
        );

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

  // 只把 `@预设名` 作为文案插入输入框，不写入任何激活状态：
  // 该预设仅对当条消息生效，发送时由 fetch-hook 解析（core/preset/mention.ts）。
  setNativeTextareaValue(textarea, `@${preset.name} `, '');
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
  const container = popupEl;

  container.textContent = '';
  filtered.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = `dpp-preset-item${i === activeIdx ? ' dpp-active' : ''}`;
    item.dataset.i = String(i);

    const head = document.createElement('div');
    head.className = 'dpp-preset-head';

    const trigger = document.createElement('code');
    trigger.className = 'dpp-preset-trigger';
    trigger.textContent = `@${p.name}`;

    const desc = document.createElement('div');
    desc.className = 'dpp-preset-desc';
    desc.textContent = p.content;

    head.appendChild(trigger);
    item.append(head, desc);
    item.addEventListener('mouseenter', () => {
      activeIdx = i;
      highlightActive();
    });
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectPreset(filtered[i]);
    });
    container.appendChild(item);
  });

  const hint = document.createElement('div');
  hint.className = 'dpp-preset-hint';
  hint.textContent = '↑↓ 导航 · Enter 选择 · Esc 关闭';
  container.appendChild(hint);
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

function injectStyles() {
  injectStyleElement('dpp-preset-popup-css', `
${popupChromeCss('preset', 'var(--dpp-preset-bg, #FFFBEB)')}
.dpp-preset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dpp-preset-trigger {
  color: var(--dpp-preset-color, #D97706);
  font-size: 13px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-weight: 600;
  background: var(--dpp-preset-bg, #FFFBEB);
  padding: 1px 6px;
  border-radius: 4px;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dpp-preset-desc {
  color: var(--dpp-prompt-text-muted, #9CA3AF);
  font-size: 11px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dpp-preset-hint {
  text-align: center;
  color: var(--dpp-prompt-text-faint, #D1D5DB);
  font-size: 10px;
  padding: 4px 0 2px;
  border-top: 1px solid var(--dpp-prompt-hint-border, #F3F4F6);
  margin-top: 4px;
}
`);
}
