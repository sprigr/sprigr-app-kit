/** Filter bar, segmented control, and toggle switch. */
import type { ReactNode } from 'react';

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 flex-wrap mb-3">{children}</div>;
}

export interface SegmentedOption {
  value: string;
  label: string;
  count?: number;
}

export function Segmented({ options, value, onChange }: { options: SegmentedOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg" style={{ background: 'var(--surface-inset)' }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="px-2.5 py-1 rounded-md text-[12px] font-medium transition-all"
          style={{ background: value === o.value ? 'var(--surface)' : 'transparent', color: value === o.value ? 'var(--text)' : 'var(--text-3)', boxShadow: value === o.value ? 'var(--shadow-sm)' : 'none' }}
        >
          {o.label}
          {o.count != null && <span className="ml-1 tnum" style={{ color: 'var(--text-4)' }}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="inline-flex items-center gap-2 text-[12.5px] font-medium" style={{ color: on ? 'var(--text)' : 'var(--text-3)' }}>
      <span className="relative transition-colors" style={{ width: 32, height: 18, borderRadius: 999, background: on ? 'var(--accent)' : 'var(--border-strong)' }}>
        <span className="absolute top-0.5 transition-all" style={{ left: on ? 16 : 2, width: 14, height: 14, borderRadius: 999, background: 'white', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
      </span>
      {label}
    </button>
  );
}
