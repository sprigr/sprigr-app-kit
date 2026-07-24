/**
 * Server-rendered timezone `<select>`.
 *
 * Why a native `<select>` with `<optgroup>`:
 *   - Works in pure SSR (no `"use client"` boundary, no client-bundle bytes).
 *   - Mobile browsers render a system picker UI for free.
 *   - Form submissions land in `req.formData()` like any other input —
 *     no extra wiring on the API-handler side.
 *
 * Why no fancy combobox / autocomplete:
 *   - Adding a searchable dropdown means a `"use client"` client component,
 *     which historically broke SSR in marketplace apps (see intabot v0.1.25
 *     SPRIGR_READY_SCRIPT comment for the precedent). The native `<select>`
 *     with grouped options is fast enough — ~85 zones across 8 optgroups.
 */
import * as React from "react";
import { TIMEZONE_GROUPS } from "./timezones";

export interface TimezoneSelectProps {
  /** Form field name. Submitted under this key in the form data. */
  name: string;
  /** Default selected zone. Falls back to `"UTC"` so the form is always
   * submittable even when the customer hasn't persisted a timezone yet. */
  defaultValue?: string;
  /** Form input's `required` attribute. Default true — a missing
   * timezone is rarely valid downstream and the dropdown always has UTC
   * available, so there's no good "no selection" reason. */
  required?: boolean;
  /** Inline style — apps that style their forms via raw style objects
   * (intabot) can pass their `inputStyle` token through. */
  style?: React.CSSProperties;
  /** Optional class name for tailwind/CSS-module-styled apps. */
  className?: string;
  /** id attribute (for `<label htmlFor=...>` pairing). */
  id?: string;
  /** aria-label for screen readers if the visible label is decoupled. */
  ariaLabel?: string;
}

export function TimezoneSelect({
  name,
  defaultValue = "UTC",
  required = true,
  style,
  className,
  id,
  ariaLabel,
}: TimezoneSelectProps): React.ReactElement {
  return (
    <select
      name={name}
      id={id}
      defaultValue={defaultValue}
      required={required}
      style={style}
      className={className}
      aria-label={ariaLabel}
    >
      {TIMEZONE_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
