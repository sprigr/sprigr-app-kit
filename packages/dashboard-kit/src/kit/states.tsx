/** Loading shimmer, empty state, and retryable error state. */
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function Loading({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="shimmer rounded-lg" style={{ height: 'var(--row-h)', opacity: 1 - i * 0.13 }} />
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'inbox', title, hint, action }: { icon?: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 gridpaper" style={{ border: '1px solid var(--border)' }}>
        <Icon name={icon} size={22} className="text-ink-4" />
      </div>
      <p className="text-[14px] font-semibold text-ink">{title}</p>
      {hint && <p className="text-[12.5px] text-ink-3 mt-1 max-w-xs">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ onRetry, detail }: { onRetry?: () => void; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--err-soft)' }}>
        <Icon name="alert-triangle" size={22} style={{ color: 'var(--err)' }} />
      </div>
      <p className="text-[14px] font-semibold text-ink">Couldn&rsquo;t load this view</p>
      <p className="text-[12.5px] text-ink-3 mt-1 max-w-xs">{detail || 'Something went wrong fetching this data. It is usually momentary, so try again.'}</p>
      {onRetry && <button type="button" onClick={onRetry} className="btn btn-outline mt-4"><Icon name="refresh" size={13} /> Retry</button>}
    </div>
  );
}
