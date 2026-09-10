import { defineConfig, presetWind4 } from 'unocss';

/**
 * UnoCSS 配置（v0.6.1 引入）。
 *
 * 策略：**与现有 Tailwind v4 并存，使用 `u-` 前缀隔离**。
 * - 存量页面继续走 Tailwind（视觉零变更，满足「保持主题、配色不变」）；
 * - 新增/改造的控件与状态用 `u-*` 工具类（布局、过渡、动效、伪类变体等），逐步替换；
 * - 关闭 Uno 的 reset / theme / property preflight，避免与 Tailwind、tokens.css 互相覆盖。
 *
 * 后续若确认视觉一致，可再评估「去掉 Tailwind、全量切到 UnoCSS presetWind4」。
 */
export default defineConfig({
  presets: [
    presetWind4({
      prefix: 'u-',
      preflights: {
        reset: false,
        theme: false,
        property: false,
      },
    }),
  ],
});
