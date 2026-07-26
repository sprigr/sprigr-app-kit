# @sprigr/apps-timezone-picker

IANA timezone data plus a server-rendered `<TimezoneSelect>` for Sprigr marketplace apps that collect a "pick your timezone" form value.

```bash
npm install @sprigr/apps-timezone-picker
```

```tsx
import { TimezoneSelect, isKnownTimezone } from '@sprigr/apps-timezone-picker';

<TimezoneSelect name="timezone" defaultValue={saved ?? 'UTC'} />;
```

Validate on the way back in, before persisting:

```ts
const tz = String(form.get('timezone') ?? '');
if (!isKnownTimezone(tz)) return badRequest('unknown timezone');
```

## Exports

- `TimezoneSelect` — native grouped `<select>` with `<optgroup>`. Pure SSR: no `"use client"` boundary and no client-bundle bytes, and mobile browsers give you a system picker for free. Props: `name` (required), `defaultValue` (falls back to `UTC`), `required` (default true), `style`, `className`, `id`, `ariaLabel`. `TimezoneSelectProps` is exported alongside it.
- `TIMEZONE_GROUPS` — timezones grouped by region, the order the component renders.
- `ALL_TIMEZONES` — flat list of every IANA zone offered.
- `isKnownTimezone(value)` — validate a submitted value before persisting it.

`react` is a peer dependency (`^19`); it is not bundled.
