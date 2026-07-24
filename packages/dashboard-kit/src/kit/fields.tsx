/** Key/value detail row + titled field group. */
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function KV({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-[12.5px] text-ink-3 shrink-0">{label}</span>
      <span className={`text-[12.5px] text-ink text-right ${mono ? 'font-mono' : ''}`} style={{ fontWeight: 500 }}>{children}</span>
    </div>
  );
}

export function FieldGroup({ title, children, icon }: { title?: ReactNode; children: ReactNode; icon?: string }) {
  return (
    <div className="mb-5">
      {title && (
        <div className="flex items-center gap-1.5 mb-2">
          {icon && <Icon name={icon} size={13} className="text-ink-4" />}
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-4">{title}</h4>
        </div>
      )}
      {children}
    </div>
  );
}
