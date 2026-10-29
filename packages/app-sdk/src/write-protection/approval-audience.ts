/**
 * `emailAudience`: the `_approval.audience` for a mail send (sprigr-team
 * decision 0312), from the recipient arguments the call actually sends to.
 *
 *   audience: emailAudience({ to: args.to, cc: args.cc, sender: viaOwnConnection ? 'actor' : 'other' }),
 */
import type { AppApprovalAudience } from './types';

/** The platform's limit; a longer list is dropped there, so it is omitted here. */
const MAX_RECIPIENTS = 50;
/** The platform drops the whole audience over this; a longer name is blanked here instead. */
export const MAX_AUDIENCE_NAME_CHARS = 128;
const BARE_ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+$/;

export type RecipientInput = string | readonly string[] | undefined | null;

export interface EmailAudienceInput {
  to?: RecipientInput;
  cc?: RecipientInput;
  bcc?: RecipientInput;
  sender: 'actor' | 'other';
}

/**
 * Lowercased, deduplicated recipients. Returns undefined (omit the field, and
 * the card shows) when there are none, too many, or any entry is not an
 * address, since a partial list must never stand for the whole audience.
 *
 * A "Name <address>" entry also gives `names[i]` for `recipients[i]`
 * (decision 0318), so an unattended step that says "email Riley" matches
 * Riley's address. `names` is omitted when no entry carries one.
 */
export function emailAudience(input: EmailAudienceInput): AppApprovalAudience | undefined {
  const out: string[] = [];
  const names: string[] = [];
  for (const list of [input.to, input.cc, input.bcc]) {
    if (list === undefined || list === null) continue;
    const items = typeof list === 'string' ? list.split(/[,;]/) : list;
    for (const raw of items) {
      if (typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const angled = trimmed.match(/<([^<>]+)>\s*$/);
      const addr = (angled?.[1] ?? trimmed).trim().toLowerCase();
      if (!BARE_ADDRESS.test(addr)) return undefined;
      const name = angled ? displayName(trimmed.slice(0, angled.index)) : '';
      const at = out.indexOf(addr);
      if (at === -1) {
        out.push(addr);
        names.push(name);
      } else if (!names[at]) {
        names[at] = name;
      }
    }
  }
  if (out.length === 0 || out.length > MAX_RECIPIENTS) return undefined;
  return names.some(Boolean) ? { recipients: out, names, sender: input.sender } : { recipients: out, sender: input.sender };
}

/** `"Riley Hart" ` -> `Riley Hart`; '' when it is over the platform limit. */
function displayName(raw: string): string {
  const name = raw.trim().replace(/^"(.*)"$/, '$1').trim();
  return name.length > MAX_AUDIENCE_NAME_CHARS ? '' : name;
}
