/**
 * @sprigr/apps-timezone-picker
 *
 * Shared IANA timezone data + a server-rendered `<TimezoneSelect>`
 * component for marketplace apps that need a "pick your timezone" form
 * input. Cross-app reusable — intabot, linkedin, and any future app that
 * collects a schedule timezone should import from here rather than
 * re-implementing the list.
 *
 * Workspace import path: `@sprigr/apps-timezone-picker`
 * Vendored path inside apps: `src/lib/vendor/timezone-picker`
 * (`pnpm sync:vendor` in the repo root mirrors the package source into
 * every consuming app's vendor dir — required because the marketplace
 * build sandbox cannot resolve `workspace:*` deps. See
 * docs/marketplace-app-development.md.)
 */
export { TimezoneSelect } from "./TimezoneSelect";
export type { TimezoneSelectProps } from "./TimezoneSelect";
export {
  TIMEZONE_GROUPS,
  ALL_TIMEZONES,
  isKnownTimezone,
} from "./timezones";
export type { TimezoneGroup } from "./timezones";
