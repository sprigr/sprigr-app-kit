# @sprigr/apps-dashboard-kit

Design system for the admin dashboard a Sprigr marketplace app ships: one warm-neutral + indigo theme, light and dark, three density steps, and a React component kit (tables, badges, drawers, confirm dialogs, audit timelines, states, filters, toasts). Built so any app with an operator-facing screen gets a consistent look without re-deriving one.

```bash
npm install @sprigr/apps-dashboard-kit
```

## Requirements

- **React 18+** and **react-dom 18+** (peer deps, not bundled).
- **lucide-react** (peer dep). The `Icon` component resolves names onto lucide glyphs.
- **Tailwind v4** in the consuming app. The components use Tailwind utility classes, and the kit's CSS registers its tokens as Tailwind theme values. Without Tailwind you still get the token layer and the `.card` / `.btn` / `.pill` component classes, plus the fallback colour utilities at the bottom of `tokens.css`, but the layout utilities the components use will not resolve.

## Wiring it up

Two things: import the CSS after Tailwind, and point Tailwind at the kit so it generates the utility classes the components reference.

```css
/* app globals.css */
@import "tailwindcss";
@import "@sprigr/apps-dashboard-kit/styles";
@source "../../node_modules/@sprigr/apps-dashboard-kit/dist";
```

The `@source` line matters. Tailwind v4 skips `node_modules` when scanning for class names, so without it the kit's components render unstyled. Adjust the relative path to match where your CSS file sits.

```tsx
import { DataTable, Drawer, StatusBadge, ToastProvider, useToast } from "@sprigr/apps-dashboard-kit";
```

Put `.theme-dark` on your dashboard root for dark mode, and one of `.density-compact` / `.density-cozy` / `.density-airy` to drive `DataTable` row and cell sizing.

## What's in it

**Styles** (`@sprigr/apps-dashboard-kit/styles`, or the two halves individually at `/styles/tokens.css` and `/styles/components.css`):

- `tokens.css`: palette, typography, radii, shadows, motion, and density as CSS custom properties, plus a Tailwind v4 `@theme` block mapping them to utilities (`text-ink-3`, `bg-surface-2`, `text-accent`, `font-mono`, and so on).
- `components.css`: `.card`, `.btn` and variants, `.pill`, `.inp`, `.kbd`, `.gridpaper`, the animation classes, `.shimmer`, `.pulse-dot`.

**Components** (default export path):

| Export | What it does |
|---|---|
| `Icon` | Name-to-lucide-glyph resolver. Unknown names render a dot rather than crashing. |
| `Avatar` | Initials avatar with a gradient fill. |
| `StatusBadge`, `SeverityBadge`, `ExcStatusBadge`, `FreshnessDot`, `HealthBar` | Status pills and indicators. The backing tone maps (`ROUTING_TONES`, `SEV`, `EXC_STATUS`, `FRESH`) are exported so you can spread and extend them. |
| `Code`, `CopyChip` | Monospace chip and click-to-copy chip (with optional masking for secrets). |
| `Loading`, `EmptyState`, `ErrorState` | The three async states. |
| `DataTable`, `Checkbox` | Generic column-driven table with optional row selection. Density-aware. |
| `FilterBar`, `Segmented`, `Toggle` | Filter controls. |
| `Drawer` | Right-side slide-in. Locks body scroll, closes on Esc or overlay click. |
| `AuditTimeline` | Vertical event timeline. See below. |
| `KV`, `FieldGroup` | Key/value detail rows and titled groups. |
| `ConfirmDialog` | Simple confirm, or destructive "type the keyword to arm". |
| `ResultPanel` | Echoes a tool's structured return payload after a mutation. |
| `StatTile` | Clickable big-number tile. |
| `ToastProvider`, `useToast` | Bottom-right auto-dismissing toasts. |
| `TONE_C` | The shared tone-to-CSS-var map used by timelines, tiles and toasts. |
| `relTime`, `relFromMs`, `ageLabel`, `money` | Formatting helpers. |

### AuditTimeline event tones

Row colour is derived from the event name's final dotted segment, so a namespaced stream colours itself with no configuration:

```tsx
<AuditTimeline items={[{ event_type: "order.created", t: 900_000 }]} />
```

`created` maps to `info`, `failed` to `err`, `delivered` and `resolved` to `ok`, and so on. The full default map is exported as `DEFAULT_EVENT_TONES`. To cover names it does not know, pass `tones`; a full event name wins over a bare suffix, which wins over the default:

```tsx
<AuditTimeline
  items={events}
  tones={{ "shipment.first_scan_in": "info", quarantined: "warn" }}
/>
```

## Re-skinning

Override `--accent`, `--accent-2`, `--accent-soft`, `--accent-ink` (or any other token) on a root element or in your app CSS. Everything downstream, including the Tailwind theme values, references the live custom properties, so a runtime override flows through the whole kit.

## Vendoring instead of installing

This package is on npm, so an exact-pinned dependency is the right choice for a marketplace app. The `sprigrVendor` + `pnpm sync:vendor` source mirror in this repo remains as the fallback for packages that cannot be published; you should not need it here. See [docs/publishing.md](../../docs/publishing.md).
