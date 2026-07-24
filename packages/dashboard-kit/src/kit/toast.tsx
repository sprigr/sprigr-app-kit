/** Toast provider + useToast() hook. Bottom-right, tone-colored, auto-dismiss. */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { TONE_C } from './tones';

type ToastTone = 'ok' | 'err' | 'warn' | 'info' | 'neutral';
type PushFn = (msg: ReactNode, tone?: ToastTone) => void;

const ToastCtx = createContext<PushFn | null>(null);

interface ToastItem { id: string; msg: ReactNode; tone: ToastTone }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback<PushFn>((msg, tone = 'neutral') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { id, msg, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="card px-3.5 py-2.5 text-[13px] flex items-center gap-2 anim-fade-up pointer-events-auto" style={{ boxShadow: 'var(--shadow-lg)' }}>
            <Icon name={t.tone === 'ok' ? 'check-circle' : t.tone === 'err' ? 'x-circle' : 'activity'} size={14} style={{ color: TONE_C[t.tone] || 'var(--accent)' }} />
            <span className="text-ink">{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): PushFn {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within a <ToastProvider>');
  return ctx;
}
