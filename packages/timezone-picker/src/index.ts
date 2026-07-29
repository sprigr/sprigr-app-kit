/**
 * @sprigr/apps-timezone-picker
 *
 * Shared IANA timezone data + a server-rendered `<TimezoneSelect>`
 * component for marketplace apps that need a "pick your timezone" form
 * input. Any app that collects a schedule timezone should import from here
 * rather than re-implementing the list.
 *
 * Published to npm as `@sprigr/apps-timezone-picker`; apps depend on it
 * like any other package. It used to be mirrored into each app's
 * `src/lib/vendor/timezone-picker` by `pnpm sync:vendor`, because the
 * marketplace build sandbox runs `npm install` with no workspace context
 * and so cannot resolve `workspace:*`. Publishing removes that need: the
 * sandbox resolves a registry dependency fine.
 */
export { TimezoneSelect } from "./TimezoneSelect";
export type { TimezoneSelectProps } from "./TimezoneSelect";
export {
  TIMEZONE_GROUPS,
  ALL_TIMEZONES,
  isKnownTimezone,
} from "./timezones";
export type { TimezoneGroup } from "./timezones";
