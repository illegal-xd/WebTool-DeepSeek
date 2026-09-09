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
