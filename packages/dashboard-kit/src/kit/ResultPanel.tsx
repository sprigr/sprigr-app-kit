/** Echoes a tool's structured return payload (mono JSON) after a mutation. */
import { Icon } from './Icon';

export interface ToolResult {
  title?: string;
  tool?: string;
  payload: unknown;
}

export function ResultPanel({ result }: { result: ToolResult | null }) {
  if (!result) return null;
  return (
    <div className="rounded-xl overflow-hidden anim-fade-up" style={{ border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
        <Icon name="check-circle" size={13} style={{ color: 'var(--ok)' }} />
        <span className="text-[12px] font-semibold text-ink">{result.title || 'Result'}</span>
        {result.tool && <span className="ml-auto font-mono text-[10.5px] text-ink-4">{result.tool}</span>}
      </div>
      <pre className="px-3 py-2.5 font-mono text-[11.5px] leading-relaxed overflow-x-auto scroll-thin text-ink-2" style={{ background: 'var(--surface)' }}>
        {JSON.stringify(result.payload, null, 2)}
      </pre>
    </div>
  );
}
