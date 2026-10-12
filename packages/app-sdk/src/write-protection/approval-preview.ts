/**
 * Builders for `_approval.preview` (sprigr-team decision 0216). They return
 * plain objects; the point is the types and the defaults, so a send tool
 * declares its card in one line:
 *
 *   describe: (_t, a, mailbox) => ({
 *     question: `Send an email to ${a.to}?`, header: 'Outlook',
 *     preview: emailPreview({ from: { value: mailbox }, to: 'to', subject: 'subject', body: 'body' }),
 *   })
 *
 * Every string slot is the NAME of one of your tool's arguments (or a dotted
 * path such as `input.body`). The platform reads the value from the exact
 * arguments it replays when the person taps, never from anything you send
 * here, so bind the argument you actually send.
 */

import type { ApprovalPreviewFact, ApprovalPreviewSlot, ApprovalPreviewSpec } from './types';

export interface EmailPreviewInput {
  from?: ApprovalPreviewSlot;
  to: ApprovalPreviewSlot;
  cc?: ApprovalPreviewSlot;
  bcc?: ApprovalPreviewSlot;
  subject?: ApprovalPreviewSlot;
  /** Argument name of the body. */
  body: string;
  /**
   * Defaults to 'html'. Use 'auto' when the tool sends the body through
   * `emailBodyHtml`, so a plain-text body shows on the card with its lines.
   */
  bodyFormat?: 'html' | 'text' | 'auto';
  attachments?: string;
  sendAt?: ApprovalPreviewSlot;
  /** Defaults to ['irreversible']: a sent email cannot be recalled. */
  facts?: ApprovalPreviewFact[];
}

export function emailPreview(input: EmailPreviewInput): ApprovalPreviewSpec {
  return {
    kind: 'email',
    ...(input.from !== undefined ? { from: input.from } : {}),
    to: input.to,
    ...(input.cc !== undefined ? { cc: input.cc } : {}),
    ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    body: { arg: input.body, format: input.bodyFormat ?? 'html' },
    ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
    ...(input.sendAt !== undefined ? { sendAt: input.sendAt } : {}),
    facts: input.facts ?? ['irreversible'],
  };
}

export interface SmsPreviewInput {
  from?: ApprovalPreviewSlot;
  to: ApprovalPreviewSlot;
  /** Argument name of the message text. */
  body: string;
  /** Defaults to ['irreversible']. Add 'costs_credits' when it does. */
  facts?: ApprovalPreviewFact[];
}

export function smsPreview(input: SmsPreviewInput): ApprovalPreviewSpec {
  return {
    kind: 'sms',
    ...(input.from !== undefined ? { from: input.from } : {}),
    to: input.to,
    body: { arg: input.body, format: 'text' },
    facts: input.facts ?? ['irreversible'],
  };
}

/** Label and value rows: an invoice's number and total, an event's time. */
export function fieldsPreview(
  kind: 'document' | 'calendar' | 'fields',
  rows: Array<{ label: string; from: ApprovalPreviewSlot }>,
  extra: Pick<ApprovalPreviewSpec, 'to' | 'from' | 'subject' | 'facts'> = {},
): ApprovalPreviewSpec {
  return { kind, ...extra, fields: rows };
}
