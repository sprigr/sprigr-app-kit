/**
 * `emailAudience`: the `_approval.audience` for a mail send (sprigr-team
 * decision 0312), from the recipient arguments the call actually sends to.
 *
 *   audience: emailAudience({ to: args.to, cc: args.cc, sender: viaOwnConnection ? 'actor' : 'other' }),
 */
import type { AppApprovalAudience } from './types';

/** The platform's limit; a longer list is dropped there, so it is omitted here. */
const MAX_RECIPIENTS = 50;
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
 */
export function emailAudience(input: EmailAudienceInput): AppApprovalAudience | undefined {
  const out: string[] = [];
  for (const list of [input.to, input.cc, input.bcc]) {
    if (list === undefined || list === null) continue;
    const items = typeof list === 'string' ? list.split(/[,;]/) : list;
    for (const raw of items) {
      if (typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const angled = trimmed.match(/<([^<>]+)>\s*$/);
      const addr = (angled ? angled[1] : trimmed).trim().toLowerCase();
      if (!BARE_ADDRESS.test(addr)) return undefined;
      if (!out.includes(addr)) out.push(addr);
    }
  }
  if (out.length === 0 || out.length > MAX_RECIPIENTS) return undefined;
  return { recipients: out, sender: input.sender };
}
