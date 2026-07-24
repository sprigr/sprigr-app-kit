/** Generic data table + checkbox. Density is driven by --row-h / --cell-* vars. */
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface Column<R> {
  key: string;
  label: string;
  w?: number | string;
  align?: 'left' | 'right' | 'center';
  render?: (row: R) => ReactNode;
}

export interface DataTableProps<R> {
  columns: Column<R>[];
  rows: R[];
  onRowClick?: (row: R) => void;
  rowKey?: (row: R) => string;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  onToggleAll?: () => void;
  empty?: ReactNode;
}

export function Checkbox({ checked, onChange }: { checked: boolean; onChange?: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="checkbox"
      aria-checked={checked}
      className="inline-flex items-center justify-center transition-all shrink-0"
      style={{ width: 17, height: 17, borderRadius: 5, border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`, background: checked ? 'var(--accent)' : 'var(--surface)' }}
    >
      {checked && <Icon name="check" size={11} className="text-white" strokeWidth={3} />}
    </button>
  );
}

export function DataTable<R>({ columns, rows, onRowClick, rowKey = (r: R) => (r as { id: string }).id, selectable, selected, onToggle, onToggleAll, empty }: DataTableProps<R>) {
  if (!rows.length && empty) return <>{empty}</>;
  const allSel = selectable && rows.length > 0 && selected != null && rows.every((r) => selected.has(rowKey(r)));
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full" style={{ borderCollapse: 'collapse', minWidth: 720 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {selectable && (
                <th style={{ width: 38, padding: '0 0 0 14px' }}>
                  <Checkbox checked={!!allSel} onChange={onToggleAll} />
                </th>
              )}
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ width: c.w, textAlign: c.align || 'left', padding: 'var(--cell-py) var(--cell-px)' }}
                  className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-4"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={rowKey(r)}
                onClick={() => onRowClick?.(r)}
                className="group transition-colors"
                style={{ borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border)', cursor: onRowClick ? 'pointer' : 'default' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {selectable && (
                  <td style={{ padding: '0 0 0 14px' }} onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={!!selected?.has(rowKey(r))} onChange={() => onToggle?.(rowKey(r))} />
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{ textAlign: c.align || 'left', padding: 'var(--cell-py) var(--cell-px)', height: 'var(--row-h)' }}
                    className="text-[13px] text-ink-2"
                  >
                    {c.render ? c.render(r) : (r as Record<string, ReactNode>)[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
