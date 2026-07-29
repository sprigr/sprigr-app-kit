/**
 * Vertical audit/event timeline.
 *
 * Each row's dot colour comes from the event name. A namespaced event stream
 * (`order.created`, `shipment.delivered`, `sync.failed`, ...) colours itself
 * with no configuration, because the default map keys off the final dotted
 * segment. Pass `tones` to add or override entries for your own event names:
 * an exact event-name key wins, then a suffix key, then the built-in default.
 */
import { TONE_C } from './tones';

/**
 * Default event-suffix to tone mapping. Keys match the last dotted segment of
 * an event name, so `billing.invoice.failed` and `sync.failed` both resolve to
 * `err`. Extend it per app via the `tones` prop rather than editing this map.
 */
export const DEFAULT_EVENT_TONES: Record<string, string> = {
  // failure
  failed: 'err',
  error: 'err',
  errored: 'err',
  rejected: 'err',
  raised: 'err',
  expired: 'err',
  // needs attention
  escalated: 'warn',
  cancelled: 'warn',
  canceled: 'warn',
  skipped: 'warn',
  disabled: 'warn',
  paused: 'warn',
  // success
  delivered: 'ok',
  resolved: 'ok',
  completed: 'ok',
  succeeded: 'ok',
  enabled: 'ok',
  approved: 'ok',
  // in flight / informational
  requested: 'info',
  accepted: 'info',
  received: 'info',
  created: 'info',
  updated: 'info',
  started: 'info',
  queued: 'info',
  // notable, but not a state change
  reopened: 'accent',
  retried: 'accent',
};

export interface AuditItem {
  event_type: string;
  t: number; // age in ms
  payload?: Record<string, unknown> | null;
}

export interface AuditTimelineProps {
  items: AuditItem[];
  /**
   * Extra event-name to tone entries. A key may be a full event name
   * (`shipment.first_scan_in`) or a bare suffix (`first_scan_in`). Values are
   * `TONE_C` keys: `err`, `warn`, `ok`, `info`, `accent`, `neutral`.
   */
  tones?: Record<string, string>;
}

/** Exact event name first, then a suffix override, then the built-in default. */
export function resolveEventTone(eventType: string, tones?: Record<string, string>): string {
  const suffix = eventType.slice(eventType.lastIndexOf('.') + 1);
  return tones?.[eventType] ?? tones?.[suffix] ?? DEFAULT_EVENT_TONES[suffix] ?? 'neutral';
}

function payloadLine(p: Record<string, unknown> | null | undefined): string | null {
  if (!p) return null;
  return Object.entries(p)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ·  ');
}

function ageAgo(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round((m / 60) * 10) / 10}h`;
  return `${Math.round((m / 1440) * 10) / 10}d`;
}

export function AuditTimeline({ items, tones }: AuditTimelineProps) {
  return (
    <div className="relative pl-1">
      {items.map((it, i) => {
        const tone = resolveEventTone(it.event_type, tones);
        const line = payloadLine(it.payload);
        return (
          <div key={i} className="relative flex gap-3 pb-4 last:pb-0">
            <div className="relative flex flex-col items-center">
              <span style={{ width: 9, height: 9, borderRadius: 999, background: TONE_C[tone] ?? TONE_C.neutral, marginTop: 3, boxShadow: '0 0 0 3px var(--surface)' }} />
              {i < items.length - 1 && <span className="flex-1 w-px mt-1" style={{ background: 'var(--border-strong)' }} />}
            </div>
            <div className="min-w-0 flex-1 -mt-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] font-medium text-ink">{it.event_type}</span>
                <span className="text-[11px] text-ink-4 tnum shrink-0">{ageAgo(it.t)} ago</span>
              </div>
              {line && <p className="text-[11.5px] text-ink-3 mt-0.5 font-mono leading-relaxed break-words">{line}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
