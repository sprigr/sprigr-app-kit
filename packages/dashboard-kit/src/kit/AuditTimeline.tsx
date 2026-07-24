/** Vertical audit/event timeline. Items: { event_type, t (age ms), payload? }. */
import { TONE_C } from './tones';

const EV_TONE: Record<string, string> = {
  'routing.requested': 'neutral',
  'routing.reopened': 'accent',
  'routing.cancelled': 'warn',
  'routing.failed': 'err',
  'jsj.order.accepted': 'info',
  'jsj.order.tracking_received': 'info',
  'jsj.order.failed': 'err',
  'jsj.shipment.first_scan_in': 'info',
  'jsj.shipment.first_scan_out': 'info',
  'jsj.shipment.destination_arrival': 'info',
  'jsj.shipment.delivered': 'ok',
  'exception.raised': 'err',
  'exception.escalated': 'warn',
  'exception.resolved': 'ok',
  'warehouse.enabled_for_brand': 'ok',
  'warehouse.disabled_for_brand': 'warn',
};

export interface AuditItem {
  event_type: string;
  t: number; // age in ms
  payload?: Record<string, unknown> | null;
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

export function AuditTimeline({ items }: { items: AuditItem[] }) {
  return (
    <div className="relative pl-1">
      {items.map((it, i) => {
        const tone = EV_TONE[it.event_type] || 'neutral';
        const line = payloadLine(it.payload);
        return (
          <div key={i} className="relative flex gap-3 pb-4 last:pb-0">
            <div className="relative flex flex-col items-center">
              <span style={{ width: 9, height: 9, borderRadius: 999, background: TONE_C[tone], marginTop: 3, boxShadow: '0 0 0 3px var(--surface)' }} />
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
