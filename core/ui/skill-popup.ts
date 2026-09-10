import type { Skill } from '../types';
import { sortSkillsByWeight } from '../weighting';
import { injectStyleElement, popupChromeCss, setNativeTextareaValue } from './popup-common';

let popupEl: HTMLElement | null = null;
let skills: Skill[] = [];
let filtered: Skill[] = [];
let activeIdx = 0;
let textarea: HTMLTextAreaElement | null = null;

let initialized = false;

export function initSkillPopup(initialSkills: Skill[]) {
  skills = initialSkills;
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

  if (val.startsWith('/') && !val.slice(1).includes(' ')) {
    const query = val.slice(1).toLowerCase();
    filtered = query === ''
      ? sortSkillsByWeight(skills)
      : sortSkillsByWeight(
          skills.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)),
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
      selectSkill(filtered[activeIdx]);
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

function selectSkill(skill: Skill) {
  if (!textarea || !skill) return;

  setNativeTextareaValue(textarea, `/${skill.name} `, '');
  hidePopup();
}

function showPopup() {
  if (!textarea) return;

  if (!popupEl) {
    popupEl = document.createElement('div');
    popupEl.className = 'dpp-skill-popup';
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
  filtered.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = `dpp-skill-item${i === activeIdx ? ' dpp-active' : ''}`;
    item.dataset.i = String(i);

    const head = document.createElement('div');
    head.className = 'dpp-skill-head';

    const trigger = document.createElement('code');
    trigger.className = 'dpp-skill-trigger';
    trigger.textContent = `/${s.name}`;

    const desc = document.createElement('div');
    desc.className = 'dpp-skill-desc';
    desc.textContent = s.description;

    head.appendChild(trigger);
    item.append(head, desc);
    item.addEventListener('mouseenter', () => {
      activeIdx = i;
      highlightActive();
    });
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectSkill(filtered[i]);
    });
    container.appendChild(item);
  });

  const hint = document.createElement('div');
  hint.className = 'dpp-skill-hint';
  hint.textContent = '↑↓ 导航 · Enter 选择 · Esc 关闭';
  container.appendChild(hint);
}

function highlightActive() {
  if (!popupEl) return;
  popupEl.querySelectorAll('.dpp-skill-item').forEach((el, i) => {
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
  injectStyleElement('dpp-skill-popup-css', `
${popupChromeCss('skill', 'var(--dpp-prompt-active-bg, #F7F8FA)')}
.dpp-skill-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dpp-skill-trigger {
  color: var(--dpp-skill-color, #4D6BFE);
  font-size: 13px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-weight: 600;
  background: var(--dpp-skill-bg, #EEF1FF);
  padding: 1px 6px;
  border-radius: 4px;
}
.dpp-skill-desc {
  color: var(--dpp-prompt-text-muted, #9CA3AF);
  font-size: 11px;
  margin-top: 2px;
}
.dpp-skill-hint {
  text-align: center;
  color: var(--dpp-prompt-text-faint, #D1D5DB);
  font-size: 10px;
  padding: 4px 0 2px;
  border-top: 1px solid var(--dpp-prompt-hint-border, #F3F4F6);
  margin-top: 4px;
}
`);
}
