/**
 * Showcase - add the acting person's Inbox signature to mail the app sends as
 * them (sprigr-team decision 0255).
 *
 * The rules a mail app follows, all here:
 *   - feature-detect: a platform without env.SPRIGR.me sends the body as is;
 *   - append only when the signature belongs to the OWNER of the mailbox the
 *     mail goes out from (never from a shared mailbox or as someone else);
 *   - skip when the body already contains it (the agent signed it itself);
 *   - HTML bodies get the HTML under a "-- " separator.
 * A refusal (no_person, actor_unverified, ...) is not an error: send without.
 */

import type { SprigrHost } from './sprigr-host';

export async function withMySignature(
  sprigr: Pick<SprigrHost, 'me'>,
  args: { html: string; channel: string; mailboxOwnerPlatformUserId: string },
): Promise<string> {
  if (typeof sprigr.me?.signature !== 'function') return args.html;
  const sig = await sprigr.me.signature({ channel: args.channel });
  if (!sig.ok || !sig.html) return args.html;
  if (sig.platform_user_id !== args.mailboxOwnerPlatformUserId) return args.html;
  if (args.html.includes(sig.html)) return args.html;
  return `${args.html}<br><br>-- <br>${sig.html}`;
}

/** The call the capability-coverage check looks for: env.SPRIGR.me.signature. */
export function signatureSample(env: { SPRIGR: Pick<SprigrHost, 'me'> }, mailboxOwnerPlatformUserId: string) {
  return withMySignature(env.SPRIGR, { html: '<p>Order SO-1042 has shipped.</p>', channel: 'outlook_mail', mailboxOwnerPlatformUserId });
}
