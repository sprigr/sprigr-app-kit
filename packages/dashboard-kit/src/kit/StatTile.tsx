/** Clickable stat tile (big number + label + optional sub + tone icon). */
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { TONE_C } from './tones';

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  icon?: string;
  onClick?: () => void;
  active?: boolean;
}

export function StatTile({ label, value, sub, tone = 'neutral', icon, onClick, active }: StatTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="card p-3.5 text-left transition-all"
      style={{ cursor: onClick ? 'pointer' : 'default', borderColor: active ? 'var(--accent)' : 'var(--border)', boxShadow: active ? '0 0 0 3px var(--accent-soft)' : 'var(--shadow-sm)' }}
      onMouseEnter={(e) => { if (onClick) (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'none'; }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] font-medium text-ink-3">{label}</span>
        {icon && <Icon name={icon} size={14} style={{ color: TONE_C[tone] }} />}
      </div>
      <div className="flex items-end gap-2 mt-1.5">
        <span className="text-[26px] font-semibold tracking-tight tnum text-ink leading-none">{value}</span>
        {sub && <span className="text-[11.5px] text-ink-4 mb-0.5">{sub}</span>}
      </div>
    </button>
  );
}
