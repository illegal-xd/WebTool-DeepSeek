import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> {
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** 未匹配到选项时显示的占位文案 */
  placeholder?: string;
  disabled?: boolean;
  /** 外层容器附加类（布局用：flex-1 / shrink-0 / mt-1） */
  className?: string;
  /** 触发器附加类（视觉用：圆角 / 内边距 / 字号） */
  triggerClassName?: string;
  ariaLabel?: string;
}

/** 面板单行高度估算（含间距），用于判断是否向上翻转 */
const OPTION_ESTIMATE = 34;
const PANEL_EXTRA = 16;

/** 闭态下可唤起面板的按键 */
const OPEN_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ']);

/** 方向键 / Home / End 的下一高亮位置；无匹配按键返回 null */
function resolveNextIndex(key: string, index: number, last: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return Math.min(index + 1, last);
    case 'ArrowUp':
      return Math.max(index - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/**
 * 自定义下拉选择：替代原生 <select>，闭态与展开面板均随主题。
 * 键盘支持 ArrowUp/Down、Home/End、Enter/Space、Escape；ARIA combobox + listbox 模式。
 */
export default function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled = false,
  className = '',
  triggerClassName = '',
  ariaLabel,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [flipUp, setFlipUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex] : null;

  const openPanel = useCallback(() => {
    if (disabled || options.length === 0) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const panelHeight = Math.min(options.length * OPTION_ESTIMATE + PANEL_EXTRA, 240);
      const spaceBelow = window.innerHeight - rect.bottom;
      setFlipUp(spaceBelow < panelHeight && rect.top > spaceBelow);
    }
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [disabled, options.length, selectedIndex]);

  const closePanel = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const commit = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closePanel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (OPEN_KEYS.has(event.key)) {
        event.preventDefault();
        openPanel();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(activeIndex);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const next = resolveNextIndex(event.key, activeIndex, options.length - 1);
    if (next !== null) {
      event.preventDefault();
      setActiveIndex(next);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        className={`ds-input flex w-full cursor-pointer items-center justify-between gap-2 text-left ${triggerClassName}`}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={onKeyDown}
      >
        <span className={`truncate ${current ? '' : 'ds-select-placeholder'}`}>{current?.label ?? placeholder}</span>
        <svg className="ds-select-chevron" data-open={open || undefined} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`ds-select-panel absolute left-0 right-0 z-30 max-h-60 overflow-y-auto overscroll-contain ${flipUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              id={`${listId}-${index}`}
              data-index={index}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              data-active={index === activeIndex || undefined}
              className="ds-select-option"
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(index)}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value && (
                <svg className="ds-select-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
