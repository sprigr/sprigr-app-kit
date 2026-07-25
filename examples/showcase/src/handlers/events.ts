/**
 * Showcase - event subscription handler (`showcase_on_deal_won`).
 *
 * Wired in manifest events.subscribes[]: when showcase.deal.won fires (this
 * app self-subscribes, and the filter `$.amount > 0` drops zero-value
 * deals cheaply), the runtime invokes this tool with EventArgs from
 * @sprigr/apps-app-sdk: { event, payload, eventId }.
 *
 * eventId is the dedup key — the runtime is at-least-once, so a handler
 * that has side effects must dedup on it. The dedup read is local (env.DB);
 * caching the contact is env.SPRIGR.data.import (staging-only).
 */

import { makeDedupLatch } from '@sprigr/apps-dedup-latch';
import { stagingOnly } from '../lib/env';
import type { EventArgs } from '@sprigr/apps-app-sdk';
import type { ShowcaseEnv, HandlerResult } from '../lib/env';

export async function onDealWon(env: ShowcaseEnv, args: EventArgs): Promise<HandlerResult> {
  // LOCAL: dedup on the runtime-supplied eventId.
  const latch = makeDedupLatch({ db: env.DB, table: 'showcase_webhook_dedup', ttlSec: 7 * 24 * 3600 });
  if (!(await latch.tryClaim(`event:${args.eventId}`))) {
    return { ok: true, result: { deduped: true } };
  }
  const payload = args.payload as { contact_id?: string; amount?: number };
  if (!payload.contact_id) return { ok: true, result: { skipped: 'no contact_id' } };

  // STAGING-ONLY: cache the winning contact + write a knowledge note.
  return stagingOnly(
    () => env.SPRIGR.data.import([{ objectID: payload.contact_id!, stage: 'won', amount: payload.amount }]),
    'onDealWon caches the winning contact via env.SPRIGR.data.import — publish to staging.',
  );
}

export default {
  showcase_on_deal_won: (args: EventArgs, env: ShowcaseEnv) => onDealWon(env, args),
};
