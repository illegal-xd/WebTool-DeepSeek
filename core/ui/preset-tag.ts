import type { SystemPromptPreset } from '../types';

let tagEl: HTMLElement | null = null;
let textarea: HTMLTextAreaElement | null = null;
let activeName: string | null = null;
let observer: MutationObserver | null = null;

export function updatePresetTag(activePreset: SystemPromptPreset | null) {
  activeName = activePreset?.name ?? null;

  if (!activeName) {
    removeTag();
    return;
  }

  if (tagEl && document.contains(tagEl)) {
    const nameEl = tagEl.querySelector('.dpp-preset-tag-name');
    if (nameEl) nameEl.textContent = activeName;
    return;
  }

  locateTextarea();
  if (textarea) {
    createTag();
  }
  startObserver();
}

function startObserver() {
  if (observer) return;

  observer = new MutationObserver(() => {
    if (!activeName) return;

    if (!tagEl || !document.contains(tagEl)) {
      tagEl = null;
      locateTextarea();
      if (textarea) createTag();
      return;
    }

    if (!textarea || !document.contains(textarea)) {
      textarea = null;
      locateTextarea();
      if (textarea) createTag();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function locateTextarea() {
  if (textarea && document.contains(textarea)) return;
  textarea = document.querySelector<HTMLTextAreaElement>('textarea#chat-input')
    || document.querySelector<HTMLTextAreaElement>('textarea');
}

function createTag() {
  removeTag();
  if (!textarea || !activeName) return;

  injectStyles();

  tagEl = document.createElement('div');
  tagEl.className = 'dpp-preset-tag';

  const nameEl = document.createElement('span');
  nameEl.className = 'dpp-preset-tag-name';
  nameEl.textContent = `已启用：${activeName}`;

  const closeEl = document.createElement('span');
  closeEl.className = 'dpp-preset-tag-close';
  closeEl.textContent = '×';

  tagEl.append(nameEl, closeEl);

  document.body.appendChild(tagEl);
  positionTag();

  closeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    deactivatePreset();
  });

  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
}

function positionTag() {
  if (!tagEl || !textarea) return;
  const rect = textarea.getBoundingClientRect();
  tagEl.style.left = `${rect.left + 30}px`;
  tagEl.style.top = `${rect.bottom + 55}px`;
}

const onScroll = () => positionTag();
const onResize = () => positionTag();

function deactivatePreset() {
  window.postMessage({
    source: 'WebTool-DeepSeek-main',
    type: 'SET_ACTIVE_PRESET',
    id: null,
  });
  removeTag();
}

function removeTag() {
  if (!tagEl) return;
  tagEl.remove();
  tagEl = null;
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.dpp-preset-tag {
  position: fixed;
  z-index: 99999;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px 2px 8px;
  background: var(--dpp-preset-bg, #FFFBEB);
  border: 1px solid var(--dpp-preset-border, #FDE68A);
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  color: var(--dpp-preset-color, #D97706);
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
  pointer-events: auto;
  animation: dpp-tag-in 0.15s ease;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--dpp-preset-color, #D97706) 18%, transparent);
}
.dpp-preset-tag-name {
  cursor: default;
}
.dpp-preset-tag-close {
  display: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  color: var(--dpp-preset-color, #D97706);
  cursor: pointer;
  transition: background 0.1s;
  margin-left: 1px;
}
.dpp-preset-tag:hover .dpp-preset-tag-close {
  display: inline-flex;
}
.dpp-preset-tag-close:hover {
  background: var(--dpp-preset-border, #FDE68A);
  color: var(--dpp-preset-color, #92400E);
}
@keyframes dpp-tag-in {
  from { opacity: 0; transform: scale(0.9); }
  to   { opacity: 1; transform: scale(1); }
}
`;
  document.head.appendChild(style);
}