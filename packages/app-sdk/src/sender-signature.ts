/**
 * The sending person's Inbox signature on mail an app sends as them
 * (sprigr-team decision 0255): one rule for every mail app, so the
 * microsoft-365 and google-workspace apps cannot drift apart.
 *
 * The platform resolves the person from the dispatch's signed actor
 * assertion (`env.SPRIGR.me.signature`); this only decides whether to append.
 * It appends when the bridge offers `me.signature`, the answer is ok and
 * carries html, the signature belongs to `senderPlatformUserId` (the owner of
 * the mailbox the mail goes out from), and the body does not already contain
 * it. The CALLER decides the mailbox: never call this for a shared or
 * delegated mailbox, nor for mail the Inbox composer wrote (it already seeded
 * the signature). Any refusal, missing bridge or failure returns the body
 * unchanged; a signature is never a reason to fail a send.
 */
import type { SprigrMeApi } from './index';

export async function withSenderSignature(
  sprigr: { me?: Pick<SprigrMeApi, 'signature'> } | undefined,
  args: { html: string; channel: string; senderPlatformUserId: string | undefined },
): Promise<string> {
  const me = sprigr?.me;
  if (!args.senderPlatformUserId || typeof me?.signature !== 'function') return args.html;
  try {
    const sig = await me.signature({ channel: args.channel });
    if (!sig.ok || !sig.html) return args.html;
    if (sig.platform_user_id !== args.senderPlatformUserId) return args.html;
    if (args.html.includes(sig.html)) return args.html;
    return `${args.html}<br><br>-- <br>${sig.html}`;
  } catch (err) {
    console.warn('[app-sdk] env.SPRIGR.me.signature failed; sending without a signature:', err instanceof Error ? err.message : err);
    return args.html;
  }
}
