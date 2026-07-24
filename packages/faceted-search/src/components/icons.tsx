/** Inline SVG glyphs used by the faceted-search UI (no icon-font dependency). */
import type { JSX } from 'react';

export function SearchIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function ChevronIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function CheckIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function ImagePlaceholderIcon(): JSX.Element {
  return (
    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" />
    </svg>
  );
}
