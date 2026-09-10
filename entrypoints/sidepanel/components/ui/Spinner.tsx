interface SpinnerProps {
  /** 直径（px，默认 14） */
  size?: number;
}

/**
 * 加载指示器（按钮内联 / 状态行）。
 * 尺寸用 UnoCSS 工具类（`u-inline-block u-align-middle`），动画与配色来自 `.ds-spin`。
 */
export default function Spinner({ size = 14 }: SpinnerProps) {
  return (
    <span
      className="ds-spin u-inline-block u-align-middle"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
