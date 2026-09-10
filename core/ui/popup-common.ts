/**
 * Popup 公共辅助：样式注入骨架 + 共用 keyframes。
 */

/** popup 面板滑入动画（memory/skill/preset 三个 popup 共用）。 */
export const SLIDE_UP_KEYFRAMES = `@keyframes dpp-slide-up {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}`;

/** 注入单个 style 元素；已存在同名 style id 时跳过。 */
export function injectStyleElement(styleId: string, css: string): void {
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * 触发弹窗（# 记忆 / / 技能 / @ 预设）共用骨架样式：面板容器 + 列表项 + 选中态 + 滑入动画。
 * activeBackground 为各弹窗自己的选中底色变量。各弹窗只需再补充头部/徽标/描述样式。
 */
export function popupChromeCss(prefix: string, activeBackground: string): string {
  return `
.dpp-${prefix}-popup {
  position: fixed;
  z-index: 99999;
  background: var(--dpp-prompt-bg, #FFFFFF);
  border: 1px solid var(--dpp-prompt-border, #E5E7EB);
  border-radius: 12px;
  padding: 4px;
  box-shadow: var(--dpp-prompt-shadow, 0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04));
  display: none;
  animation: dpp-slide-up .15s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
  backdrop-filter: blur(8px);
  max-height: 220px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
${SLIDE_UP_KEYFRAMES}
.dpp-${prefix}-item {
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background .1s;
}
.dpp-${prefix}-item.dpp-active {
  background: ${activeBackground};
}`;
}

/**
 * 把文案写入 DeepSeek 输入框（#、/、@ 三个 popup 共用），并让 React 感知变化。
 *
 * DeepSeek 输入框是受控组件：直接改 DOM 值不会触发 onChange，需要先改写 React 的
 * `_valueTracker` 再派发 input 事件。React 依据「tracker 值 ≠ DOM 值」判定变化，
 * 因此清空场景 trackerValue 传当前值（或占位 '@'），写入非空值场景传空串。
 */
export function setNativeTextareaValue(
  textarea: HTMLTextAreaElement,
  value: string,
  trackerValue: string,
): void {
  const tracker = (textarea as unknown as { _valueTracker?: { setValue: (value: string) => void } })._valueTracker;
  if (tracker) tracker.setValue(trackerValue);

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, value);
  } else {
    textarea.value = value;
  }

  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(value.length, value.length);
}
