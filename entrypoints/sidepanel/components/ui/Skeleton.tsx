import type { CSSProperties } from 'react';

interface SkeletonProps {
  /** 骨架行数（默认 1） */
  lines?: number;
  /** 容器额外样式（间距由调用方决定） */
  style?: CSSProperties;
}

/** 预置行 key（避免使用数组下标作为 key） */
const ROW_KEYS = ['row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6', 'row-7', 'row-8'];

/**
 * 骨架屏占位（列表/卡片加载中）。
 * 布局与间距用 UnoCSS 工具类（`u-*`，与 Tailwind 前缀隔离），主题底色来自 `.ds-skeleton`。
 */
export default function Skeleton({ lines = 1, style }: SkeletonProps) {
  const count = Math.max(1, lines);
  const rows = ROW_KEYS.slice(0, count);

  return (
    <div className="u-flex u-flex-col u-gap-2" style={style} aria-hidden="true">
      {rows.map((key, index) => (
        <div
          key={key}
          className="ds-skeleton u-h-4 u-w-full"
          style={{ width: count > 1 && index === rows.length - 1 ? '62%' : undefined }}
        />
      ))}
    </div>
  );
}
