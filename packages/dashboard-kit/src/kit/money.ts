/** Format integer minor units (cents) as a currency string. */
export function money(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    // Unknown currency code — fall back to a plain number + code.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
