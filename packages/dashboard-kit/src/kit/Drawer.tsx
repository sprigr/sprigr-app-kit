/** Right-side slide-in drawer. Locks body scroll, closes on Esc / overlay click. */
import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, onClose, title, subtitle, badge, children, footer }: DrawerProps) {
  useEffect(() => {
    if (open) document.documentElement.classList.add('modal-open');
    else document.documentElement.classList.remove('modal-open');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('modal-open');
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 anim-overlay-in" style={{ background: 'rgba(17,17,17,0.32)' }} onClick={onClose} />
      <div className="relative h-full flex flex-col anim-slide-left" style={{ width: 'min(var(--drawer-w), 94vw)', background: 'var(--surface)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="shrink-0 flex items-start gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h3 className="text-[15px] font-semibold text-ink tracking-tight truncate">{title}</h3>
              {badge}
            </div>
            {subtitle && <p className="text-[12.5px] text-ink-3 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost !p-1.5 shrink-0"><Icon name="close" size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin px-5 py-4">{children}</div>
        {footer && <div className="shrink-0 px-5 py-3 flex items-center gap-2" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>{footer}</div>}
      </div>
    </div>
  );
}
