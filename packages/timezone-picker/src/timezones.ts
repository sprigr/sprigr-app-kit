/**
 * Curated IANA timezone list, grouped by region for a usable native
 * `<select><optgroup>` UI.
 *
 * Source: canonical IANA tz database identifiers. We hand-curate rather
 * than calling `Intl.supportedValuesOf('timeZone')` at runtime because:
 *   1. Deterministic UX — every install sees the same options, regardless
 *      of which JS runtime (Node/Workers/etc) renders the form.
 *   2. The IANA list is ~430 entries; most are aliases nobody picks
 *      (`America/Indiana/Indianapolis`, `Antarctica/DumontDUrville`, etc.).
 *      A curated ~85-entry list of business-relevant zones is faster to
 *      scroll AND nudges customers toward canonical names like
 *      `Australia/Sydney` rather than legacy aliases like `AET`.
 *   3. Zero runtime dependency on `Intl.supportedValuesOf` — keeps this
 *      package CF-Workers-safe out of the box.
 *
 * To extend: add the IANA canonical identifier to the right region group,
 * keep within each group alphabetical. The "Common" group at the top is
 * where high-traffic zones land (avoids forcing customers to scroll
 * through the geographic groups for the timezone they'll usually pick).
 */
export interface TimezoneGroup {
  label: string;
  zones: string[];
}

export const TIMEZONE_GROUPS: ReadonlyArray<TimezoneGroup> = [
  {
    label: "Common",
    zones: [
      "UTC",
      "Australia/Sydney",
      "Europe/London",
      "America/New_York",
      "America/Los_Angeles",
      "Asia/Singapore",
      "Asia/Tokyo",
    ],
  },
  {
    label: "Australia / Pacific",
    zones: [
      "Australia/Adelaide",
      "Australia/Brisbane",
      "Australia/Darwin",
      "Australia/Hobart",
      "Australia/Melbourne",
      "Australia/Perth",
      "Australia/Sydney",
      "Pacific/Auckland",
      "Pacific/Fiji",
      "Pacific/Guam",
      "Pacific/Honolulu",
    ],
  },
  {
    label: "Asia",
    zones: [
      "Asia/Bangkok",
      "Asia/Dubai",
      "Asia/Hong_Kong",
      "Asia/Jakarta",
      "Asia/Jerusalem",
      "Asia/Karachi",
      "Asia/Kolkata",
      "Asia/Kuala_Lumpur",
      "Asia/Manila",
      "Asia/Riyadh",
      "Asia/Seoul",
      "Asia/Shanghai",
      "Asia/Singapore",
      "Asia/Taipei",
      "Asia/Tehran",
      "Asia/Tokyo",
    ],
  },
  {
    label: "Europe",
    zones: [
      "Europe/Amsterdam",
      "Europe/Athens",
      "Europe/Belgrade",
      "Europe/Berlin",
      "Europe/Brussels",
      "Europe/Bucharest",
      "Europe/Budapest",
      "Europe/Copenhagen",
      "Europe/Dublin",
      "Europe/Helsinki",
      "Europe/Istanbul",
      "Europe/Kyiv",
      "Europe/Lisbon",
      "Europe/London",
      "Europe/Madrid",
      "Europe/Moscow",
      "Europe/Oslo",
      "Europe/Paris",
      "Europe/Prague",
      "Europe/Rome",
      "Europe/Stockholm",
      "Europe/Vienna",
      "Europe/Warsaw",
      "Europe/Zurich",
    ],
  },
  {
    label: "Africa",
    zones: [
      "Africa/Accra",
      "Africa/Algiers",
      "Africa/Cairo",
      "Africa/Casablanca",
      "Africa/Johannesburg",
      "Africa/Lagos",
      "Africa/Nairobi",
    ],
  },
  {
    label: "Americas (North)",
    zones: [
      "America/Anchorage",
      "America/Chicago",
      "America/Denver",
      "America/Edmonton",
      "America/Halifax",
      "America/Los_Angeles",
      "America/Mexico_City",
      "America/New_York",
      "America/Phoenix",
      "America/St_Johns",
      "America/Toronto",
      "America/Vancouver",
      "America/Winnipeg",
    ],
  },
  {
    label: "Americas (Central / South)",
    zones: [
      "America/Argentina/Buenos_Aires",
      "America/Bogota",
      "America/Caracas",
      "America/Costa_Rica",
      "America/Guatemala",
      "America/Havana",
      "America/Lima",
      "America/Panama",
      "America/Santiago",
      "America/Sao_Paulo",
    ],
  },
  {
    label: "Atlantic",
    zones: ["Atlantic/Azores", "Atlantic/Cape_Verde", "Atlantic/Reykjavik"],
  },
];

/** Flat list of every zone in TIMEZONE_GROUPS. Useful for `includes()`
 * validation in form-handler code that needs to confirm a posted value
 * matches one of the dropdown options. */
export const ALL_TIMEZONES: ReadonlyArray<string> = Array.from(
  new Set(TIMEZONE_GROUPS.flatMap((g) => g.zones)),
);

/** Cheap server-side check: did the customer submit a valid zone? Always
 * accepts `UTC` as a safe fallback even if the curated list ever drifts. */
export function isKnownTimezone(value: string): boolean {
  return value === "UTC" || ALL_TIMEZONES.includes(value);
}
