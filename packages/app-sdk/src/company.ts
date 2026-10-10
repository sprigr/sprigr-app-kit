/**
 * The install's company, as the platform binds it (sprigr-team#11006).
 *
 * `COMPANY_TIMEZONE` is a plain_text binding stamped at upload
 * (sprigr-team#11038): the company's IANA zone, so an app can compute the
 * tenant's "today" or a local cut-off without guessing. The platform binds it
 * only when the company has a valid zone, and never a default, so an install
 * whose company has none simply has no binding. A value written before a
 * zone change stays until the install's next build.
 */

/** The env slice this module reads. Optional: older installs lack it. */
export interface CompanyTimezoneEnv {
  COMPANY_TIMEZONE?: string;
}

/**
 * The company's IANA zone, or `undefined` when there is none.
 *
 * Returns the bound value (trimmed) only when `Intl` accepts it as a time
 * zone, so the result can be handed straight to `Intl.DateTimeFormat`. Never
 * throws and never invents a zone: `undefined` means "the platform does not
 * know", and the app decides its own fallback (a per-user zone, UTC, or
 * asking).
 */
export function getCompanyTimezone(env: CompanyTimezoneEnv | null | undefined): string | undefined {
  const raw = env?.COMPANY_TIMEZONE;
  if (typeof raw !== 'string') return undefined;
  const zone = raw.trim();
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}
