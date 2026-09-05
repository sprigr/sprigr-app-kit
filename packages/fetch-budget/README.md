# @sprigr/apps-fetch-budget

Bounded outbound HTTP for Sprigr marketplace apps, under the platform dispatcher's **110-second wall**.

`fetch()` in workerd has no default timeout. A provider request that never answers hangs until something above kills the whole invocation, and for a marketplace tool or schedule that something is the dispatcher: it aborts at 110s and reports `timeout: dispatch exceeded 110000ms`, naming neither the app nor the call that hung.

```bash
npm install @sprigr/apps-fetch-budget   # exact-pin it, like every @sprigr/apps-* package
```

## Two clocks

| Clock | What it sizes | Helper |
|---|---|---|
| **Attempt cap** | one outbound request | `attemptCapMs` on `fetchWithBudget` |
| **Call budget** | every attempt, retry and throttle sleep in one invocation | a `Deadline` from `createDeadline` |

A cap alone is not a budget: three legs under a 25s cap is 75s. A pre-check is not a bound either, because the leg it admits is then awaited with nothing capping it. So the deadline is enforced twice: `budgetExhausted` refuses to start new work, and `attemptTimeoutMs` clamps each attempt to what is left, so a leg starting just under the deadline aborts **at** the deadline instead of a full cap past it.

```ts
import {
  createDeadline,
  budgetExhausted,
  fetchWithBudget,
  isFetchBudgetTimeout,
} from '@sprigr/apps-fetch-budget';

const deadline = createDeadline(25_000);        // ONCE per invocation, then thread it down

while (cursor && !budgetExhausted(deadline, 3_000)) {
  const resp = await fetchWithBudget(pageUrl(cursor), { headers }, deadline, {
    attemptCapMs: 15_000,
  });
  cursor = await handlePage(resp);
}
```

## API

- `createDeadline(totalMs, now?) => Deadline` - start a budget. Call it once per invocation.
- `remainingMs(deadline?) => number` - ms left; `Infinity` when there is no deadline.
- `budgetExhausted(deadline?, minMs?) => boolean` - gate before starting new work. `minMs` is the smallest useful leg (one page, one token refresh).
- `attemptTimeoutMs(deadline | undefined, capMs) => number` - `min(cap, time left)`, never negative.
- `fetchWithBudget(input, init, deadline?, { attemptCapMs?, fetchImpl? }) => Promise<Response>` - `fetch` bounded by both clocks. Composes (never replaces) `init.signal`.
- `budgetSignal(deadline | undefined, capMs, callerSignal?) => AbortSignal` - the bounded signal alone, for a client that owns its own `fetch` call.
- `FetchBudgetTimeoutError` - `retryable = true`, `phase: 'attempt' | 'budget'`, `url` (query stripped), `timeoutMs`. `isFetchBudgetTimeout(err)` narrows it.
- `isAbortLike(err)` - true for an `AbortError` / `TimeoutError` rejection, matched by name so a test double is recognised too.
- `DISPATCH_WALL_MS` (110000), `DEFAULT_ATTEMPT_CAP_MS` (15000).

## Failure modes

- **Deadline already passed.** `fetchWithBudget` throws `phase: 'budget'` with `timeoutMs: 0` and never opens the request.
- **Attempt cap fires.** `phase: 'attempt'`; the shared budget may still have room, so a retry inside this invocation can be worth it.
- **Deadline clamped the attempt.** `phase: 'budget'`; retrying here only re-aborts sooner. Record the leg as failed, leave the cursor unadvanced, and let the next tick pick it up.
- **Caller aborted their own signal.** Their rejection is rethrown untouched, not relabelled as a budget timeout.
- **Network error or bad URL.** Rethrown untouched.

## Retries

`@sprigr/apps-app-sdk`'s `fetchWithRetry` backs off on 429/5xx but takes no timeout and passes no signal, which is why five apps rolled their own bounded fetch. Do **not** hand it a single pre-built `budgetSignal`: the signal is per attempt, and a fired one aborts every later retry instantly. Size a fresh attempt inside your own retry loop, and gate the loop on `budgetExhausted(deadline)`.
