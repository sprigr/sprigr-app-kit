/** Two-tier confirm dialog: simple confirm, or destructive "type the keyword". */
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the confirm button is disabled until the user types this exact keyword (case-insensitive). */
  typeToConfirm?: string;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger, typeToConfirm }: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (open) setTyped(''); }, [open]);
  if (!open) return null;
  const armed = !typeToConfirm || typed.trim().toUpperCase() === typeToConfirm.toUpperCase();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 anim-overlay-in" style={{ background: 'rgba(17,17,17,0.4)' }} onClick={onClose} />
      <div className="relative card anim-scale-in w-full max-w-md p-5" style={{ boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: danger ? 'var(--err-soft)' : 'var(--accent-soft)' }}>
            <Icon name={danger ? 'alert-triangle' : 'shield-check'} size={17} style={{ color: danger ? 'var(--err)' : 'var(--accent)' }} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
            {body && <div className="text-[13px] text-ink-2 mt-1 leading-relaxed">{body}</div>}
          </div>
        </div>
        {typeToConfirm && (
          <div className="mt-4">
            <label className="text-[12px] text-ink-3">Type <span className="font-mono font-semibold text-ink">{typeToConfirm}</span> to confirm</label>
            <input className="inp mt-1.5 font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder={typeToConfirm} />
          </div>
        )}
        <div className="flex items-center justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={!armed} className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
