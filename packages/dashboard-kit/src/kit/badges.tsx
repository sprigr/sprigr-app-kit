/**
 * Status / severity / freshness / health badges.
 *
 * The exported tone maps (`ROUTING_TONES`, `SEV`, `EXC_STATUS`, `FRESH`) are
 * plain objects: spread one and add your own keys if your app's vocabulary
 * differs from the defaults.
 */
import type { ReactNode } from 'react';

type Tone = { bg: string; fg: string; dot?: string; label: string };

export const ROUTING_TONES: Record<string, Tone> = {
  pending: { bg: 'var(--surface-inset)', fg: 'var(--text-2)', dot: 'var(--text-3)', label: 'Pending' },
  accepted: { bg: 'var(--info-soft)', fg: 'var(--info)', dot: 'var(--info)', label: 'Accepted' },
  fulfilled: { bg: 'var(--ok-soft)', fg: 'var(--ok)', dot: 'var(--ok)', label: 'Fulfilled' },
  failed: { bg: 'var(--err-soft)', fg: 'var(--err)', dot: 'var(--err)', label: 'Failed' },
  cancelled: { bg: 'var(--surface-inset)', fg: 'var(--text-3)', dot: 'var(--text-4)', label: 'Cancelled' },
};

export function StatusBadge({ status }: { status: string }) {
  const t = (ROUTING_TONES[status] || ROUTING_TONES.pending)!;
  return (
    <span className="pill" style={{ background: t.bg, color: t.fg }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: t.dot, display: 'inline-block' }} />
      {t.label}
    </span>
  );
}

export const SEV: Record<string, Tone> = {
  critical: { bg: 'var(--err-soft)', fg: 'var(--err)', label: 'Critical' },
  warning: { bg: 'var(--warn-soft)', fg: 'var(--warn)', label: 'Warning' },
  info: { bg: 'var(--info-soft)', fg: 'var(--info)', label: 'Info' },
  high: { bg: 'var(--err-soft)', fg: 'var(--err)', label: 'High' },
  med: { bg: 'var(--warn-soft)', fg: 'var(--warn)', label: 'Medium' },
  low: { bg: 'var(--surface-inset)', fg: 'var(--text-2)', label: 'Low' },
};

export function SeverityBadge({ severity }: { severity: string }) {
  const t = (SEV[severity] || SEV.info)!;
  return <span className="pill" style={{ background: t.bg, color: t.fg }}>{t.label}</span>;
}

export const EXC_STATUS: Record<string, Tone> = {
  open: { bg: 'var(--err-soft)', fg: 'var(--err)', label: 'Open' },
  escalated: { bg: 'var(--warn-soft)', fg: 'var(--warn)', label: 'Escalated' },
  resolved: { bg: 'var(--ok-soft)', fg: 'var(--ok)', label: 'Resolved' },
};

export function ExcStatusBadge({ status }: { status: string }) {
  const t = (EXC_STATUS[status] || EXC_STATUS.open)!;
  return <span className="pill" style={{ background: t.bg, color: t.fg }}>{t.label}</span>;
}

export const FRESH: Record<string, { c: string; label: string }> = {
  active: { c: '#10b981', label: 'Active ≤1h' },
  recent: { c: '#f59e0b', label: 'Recent ≤24h' },
  stale: { c: '#ef4444', label: 'Stale >24h' },
  never: { c: 'var(--text-4)', label: 'Never' },
};

export function FreshnessDot({ freshness, showLabel }: { freshness: string; showLabel?: boolean }) {
  const t = (FRESH[freshness] || FRESH.never)!;
  return (
    <span className="inline-flex items-center gap-1.5" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
      <span className={freshness === 'active' ? 'pulse-dot' : ''} style={{ width: 7, height: 7, borderRadius: 999, background: t.c, display: 'inline-block' }} />
      {showLabel && (t.label as ReactNode)}
    </span>
  );
}

export function HealthBar({ value }: { value: number }) {
  const c = value >= 90 ? 'var(--ok)' : value >= 75 ? 'var(--warn)' : 'var(--err)';
  return (
    <div className="flex items-center gap-2">
      <div style={{ width: 56, height: 5, borderRadius: 999, background: 'var(--surface-inset)', overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: c, borderRadius: 999 }} />
      </div>
      <span className="tnum" style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}
