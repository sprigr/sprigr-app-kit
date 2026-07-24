/** Numeric min/max range filter. Applies on blur or Enter (not on every keystroke). */
import { useEffect, useState, type JSX } from 'react';
import type { RangeState } from '../utils/filters';

export function RangeGroup({
  label,
  value,
  onChange,
}: {
  label: string;
  value: RangeState;
  onChange: (next: RangeState) => void;
}): JSX.Element {
  const [lo, setLo] = useState(value.min?.toString() ?? '');
  const [hi, setHi] = useState(value.max?.toString() ?? '');
  useEffect(() => {
    setLo(value.min?.toString() ?? '');
  }, [value.min]);
  useEffect(() => {
    setHi(value.max?.toString() ?? '');
  }, [value.max]);
  const apply = () => onChange({ min: lo ? Number(lo) : null, max: hi ? Number(hi) : null });
  return (
    <div className="fb-group">
      <button className="fb-head" type="button">
        <span>{label}</span>
      </button>
      <div className="fb-body">
        <div className="fb-range-row">
          <input
            type="number"
            inputMode="numeric"
            placeholder="Min"
            value={lo}
            onChange={(e) => setLo(e.target.value)}
            onBlur={apply}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
          <span className="fb-dash">–</span>
          <input
            type="number"
            inputMode="numeric"
            placeholder="Max"
            value={hi}
            onChange={(e) => setHi(e.target.value)}
            onBlur={apply}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
      </div>
    </div>
  );
}
