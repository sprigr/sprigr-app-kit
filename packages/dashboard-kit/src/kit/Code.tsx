/** Monospace code chip + click-to-copy chip (with optional masking). */
import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Code({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono ${className}`} style={{ fontSize: 12, color: 'var(--text-2)' }}>{children}</span>
  );
}

export function CopyChip({ value, masked }: { value: string; masked?: boolean }) {
  const [done, setDone] = useState(false);
  const display = masked ? `${value.slice(0, 4)}····${value.slice(-2)}` : value;
  return (
    <button
      type="button"
      onClick={() => {
        try { navigator.clipboard.writeText(value); } catch { /* sandboxed iframe may block clipboard */ }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex items-center gap-1.5 font-mono rounded-md px-1.5 py-0.5 transition-colors hover:bg-surface-inset"
      style={{ fontSize: 12, color: 'var(--text-2)' }}
    >
      {display}
      <Icon name={done ? 'check' : 'copy'} size={11} className={done ? 'text-accent' : 'text-ink-4'} />
    </button>
  );
}
