# @sprigr/apps-undo-journal

Before-image storage for the Sprigr platform undo layer ([decision 0011](https://github.com/sprigr/sprigr-team/blob/main/docs/decisions/implemented/0011-app-declared-undo-envelope.md)). This is the reusable half: the bookkeeping every adopting app needs identically. Capture and replay stay in your app, because only your app knows how to read and rebuild its own objects.

## The split

| Owner | What |
|---|---|
| **Platform** | The `undo_<32 hex>` token, the payload-free registry row, the 7-day TTL, the actor + company scope, the single-use claim, and the `undo_change` / `list_undoable_changes` agent tools. |
| **This package** | The before-image table: capture, load, drop, TTL sweep, size ceiling, ref generation. |
| **Your app** | Reading the object before the write, rebuilding it on reversal, and one `internal: true` reverse tool. |

The before-image lives in **your** D1, never the platform registry. A before-image of a deleted customer is their email, address and phone; keeping it app-side means the shared registry never becomes the custodian of tenant data it cannot interpret, and it is deleted with the rest of your install's D1 on uninstall.

## Install

```bash
pnpm add @sprigr/apps-undo-journal
```

## Migration

App migrations are literal `.sql` files, immutable once shipped and CI-checked, so this package hands you the DDL rather than running it. Generate it once and paste it into a real migration:

```ts
import { undoJournalSchemaSql } from '@sprigr/apps-undo-journal';
console.log(undoJournalSchemaSql('xero_undo_journal'));
```

## Use

```ts
import { createUndoJournal } from '@sprigr/apps-undo-journal';

const journal = createUndoJournal({
  db: env.DB,
  table: 'xero_undo_journal',
  scope: 'xero-undo',            // log prefix
});

// 1. CAPTURE BEFORE THE WRITE.
const before = await getCreditNote(env, id);
const captured = await journal.captureBefore({
  entity: 'credit_note',
  originalId: id,
  before,
  connection: state.tenantId,     // see the warning below
});

// 2. Do the write. It happens whether or not the capture worked.
await voidCreditNote(env, id);

// 3. Offer the undo ONLY if the capture succeeded.
return {
  ok: true,
  ...(captured && {
    _undo: {
      fidelity: 'recreated',
      warning: 'Reversing creates a NEW credit note from the stored copy; the original number stays voided.',
      describes: `credit note ${number}`,
      resource: 'credit_note',
      ref: captured.ref,
    },
  }),
};
```

On reversal the platform dispatches your `undo.reverse_tool` with `{ ref, undo_token }`:

```ts
const row = await journal.loadBefore<CreditNote>(ref);
if (!row) return { ok: false, error: 'before-image not found or already spent' };
const pinned = withTenant(env, row.connection);   // ← re-pin, see below
await recreate(pinned, row.before);
await journal.dropBefore(ref);
```

## Three rules that are not style preferences

**A failed capture must not fail the write.** `captureBefore` returns `null` rather than throwing, on every failure path. A write that fails because its *safety net* failed is a worse outcome than a write with no safety net, and the user asked for the write. Treat `null` as "no undo offered" and carry on.

**Never return `_undo` on a `null` capture.** A token pointing at nothing is worse than no token: it invites the model to offer an undo that will fail when someone reaches for it.

**The journal never truncates.** Over the size cap it stores nothing and warns with both lengths. A half-captured object replays as silent data loss: the rebuild succeeds, looks complete, and is quietly missing fields.

## If your app can hold more than one connection, pin it

This is the sharpest edge in the whole contract, and it is why `connection` is a first-class column rather than something you tuck into the before-image.

**At redemption the platform dispatches with no memory of which store / organisation / business / company file the original write targeted.** A replay therefore falls through to whatever your app's *current* default is and rebuilds the object in the wrong customer account. Nothing errors.

- **Per-call selection** (the caller passes `store` / `organisation` / `tenant` on each call): **pin it.** Resolve the connection at capture time, pass it as `connection`, and re-pin from `row.connection` on replay. You cannot refuse instead, because there is no "current" connection for the user to switch to.
- **Session-stateful selection** (a `select_business` action sets a current one): you may **refuse** instead. Compare `row.connection` against the current one and return a clear error telling the user to switch and retry.

Either way it must be in the row. Also put it in your `_undo.describes` (`credit note CN-14341 in BoardCave AU`) so a person reading `list_undoable_changes` can tell two accounts apart.

**One more trap, learned the hard way.** If your capture runs in a wrapper that sits *outside* the layer establishing the connection pin, it will read the default connection, not the target one. Shopify shipped four bugs from exactly this, the worst being a capture reading the wrong store so a permanent delete succeeded and minted no token. Resolve and pin the connection **inside** the wrapper before calling `captureBefore`.

## Do not offer undo for money or messages

Decision 0011's rule, and it is absolute: **a tool that moved money or notified a customer declares no `_undo`.** Refunds, cancellations, payment captures, completed orders, sent mail. There is no un-charge, and an agent that sees an undo affordance will offer it. Use the confirmation gate as the only control there.

## API

| Export | Purpose |
|---|---|
| `createUndoJournal(options)` | Returns `{ captureBefore, loadBefore, dropBefore, sweepExpired }`. |
| `undoJournalSchemaSql(table)` | The canonical DDL for your migration. |
| `DEFAULT_TTL_MS` | 7 days, matching the platform token TTL. |
| `DEFAULT_MAX_BEFORE_JSON` | 400,000 chars. |

`options`: `db` (your D1 binding), `table`, `scope` (log prefix), optional `ttlMs` and `maxBeforeJson`.

The table name is interpolated into SQL (SQLite cannot bind identifiers), so it is validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` and throws otherwise.
