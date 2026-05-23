import { useEffect, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  maxWidth?: 'md' | 'lg';
  children: ReactNode;
  onClose: () => void;
}

const MAX_WIDTH_CLASS: Record<NonNullable<Props['maxWidth']>, string> = {
  md: 'max-w-md',
  lg: 'max-w-3xl',
};

export default function SidepanelModal({ open, title, subtitle, maxWidth = 'md', children, onClose }: Props) {
  useEffect(() => {
    const mainEl = document.querySelector('main');
    if (!mainEl) return;
    mainEl.style.overflowY = open ? 'hidden' : 'auto';
    return () => {
      mainEl.style.overflowY = 'auto';
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0" style={{ background: 'var(--ds-surface-scrim)' }} aria-hidden="true" />
      <div className={`relative w-full transition-all duration-300 ${MAX_WIDTH_CLASS[maxWidth]}`}>
        <div className="animate-slide-down ds-form rounded-xl overflow-hidden shadow-lg" style={{ background: 'var(--ds-bg)', borderColor: 'var(--ds-blue)' }}>
          <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-dashed" style={{ borderColor: 'var(--ds-border)' }}>
            <div className="min-w-0">
              <h3 className="text-xs font-semibold" style={{ color: 'var(--ds-text-secondary)' }}>{title}</h3>
              {subtitle && <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--ds-text-tertiary)' }}>{subtitle}</p>}
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
