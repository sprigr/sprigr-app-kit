# @sprigr/apps-dashboard-kit

Shared design system for Sprigr marketplace-app dashboards (operator + brand). One warm-neutral + indigo theme, light/dark, density variants, and a React component kit (tables, badges, drawers, confirm dialogs, audit timelines, states, filters, toasts). Built so any app shipping an admin dashboard gets the same look without re-deriving it.

## What's in it

- **`src/styles/`** — the CSS layer.
  - `tokens.css` — palette / typography / radii / shadows / motion / density as CSS vars, plus a Tailwind v4 `@theme` block mapping them to utilities (`text-ink-3`, `bg-surface-2`, `text-accent`, `font-mono`, …).
  - `components.css` — `.card`, `.btn*`, `.pill`, `.inp`, `.kbd`, `.gridpaper`, animations, `.shimmer`, `.pulse-dot`.
  - `index.css` — imports both.
- **`src/kit/`** — React components: `Icon` (lucide-backed), `Avatar`, badges (`StatusBadge`/`SeverityBadge`/`ExcStatusBadge`/`FreshnessDot`/`HealthBar`), `Code`/`CopyChip`, `Loading`/`EmptyState`/`ErrorState`, `DataTable`/`Checkbox`, `FilterBar`/`Segmented`/`Toggle`, `Drawer`, `AuditTimeline`, `KV`/`FieldGroup`, `ConfirmDialog`, `ResultPanel`, `StatTile`, `ToastProvider`/`useToast`, `TONE_C`, and `relTime`/`relFromMs`/`ageLabel`/`money` helpers.

## Requirements

- **Tailwind v4** in the consuming app (the kit's components use Tailwind utilities). Import the kit CSS *after* Tailwind.
- Peer deps: `react` >=18, `react-dom` >=18, `lucide-react`.

## Use it (workspace dev, sprigr-apps)

```css
/* app globals.css */
@import "tailwindcss";
@import "@sprigr/apps-dashboard-kit/styles";
```
```tsx
import { DataTable, Drawer, StatusBadge, ToastProvider, useToast } from "@sprigr/apps-dashboard-kit";
```
Tailwind v4 must scan the kit source for class names. In the app CSS add:
```css
@source "../../node_modules/@sprigr/apps-dashboard-kit/src";
```

## Use it (published marketplace apps — the vendor pattern)

The build-runner installs each app's `package.json` with **npm** in a fresh sandbox with no workspace context, so `@sprigr/apps-*` workspace imports don't resolve at publish time. Apps therefore **vendor a copy** of the source:

1. Declare it in the app's `package.json`:
   ```json
   { "sprigrVendor": ["dashboard-kit"] }
   ```
2. Run `pnpm sync:vendor` — mirrors `packages/dashboard-kit/src/` → `apps/<app>/src/lib/vendor/dashboard-kit/`.
3. Import from the relative mirror:
   ```css
   @import "tailwindcss";
   @import "../lib/vendor/dashboard-kit/styles/index.css";
   ```
   ```tsx
   import { DataTable } from "../lib/vendor/dashboard-kit";
   ```
   and point Tailwind at the mirror: `@source "../lib/vendor/dashboard-kit";`

`sprigr-private-apps` keeps its own duplicate of this package under its `packages/` (cross-repo sync isn't automated yet); apps there vendor from that duplicate the same way.

## Re-skinning

Override `--accent`, `--accent-2`, `--accent-soft`, `--accent-ink` (and any token) on a root element or in app CSS. Dark mode: put `.theme-dark` on the dashboard root. Density: `.density-compact|cozy|airy` on the dashboard root drives `DataTable` row/cell sizing.
