/**
 * `invalidateHome`: the one call an app makes when data behind a Home provider
 * changed (decision 0178), from anywhere in the app.
 *
 * A tool, schedule or webhook handler has `env.SPRIGR.home.invalidate`. An
 * inline route (a Next webhook receiver, a public API) does not, so this falls
 * back to the same POST the wrapper makes, with the install token. Apps used to
 * hand-write this pair each time (sprigr-app-kit#298).
 *
 * Best-effort by design: the provider's TTL is the backstop, so this never
 * throws and never holds the caller past a short timeout. A failure resolves
 * `{ ok: false }` and is logged once.
 */
import { HOME_INVALIDATE_PATH, homeInvalidateBodyFor, type HomeInvalidateInput, type HomeInvalidateResult } from './invalidate';

/** How long the inline-route POST may hold the caller. */
export const HOME_INVALIDATE_TIMEOUT_MS = 2000;

/** The parts of an app's env this reads. Every field is optional. */
export interface HomeInvalidateEnv {
  SPRIGR?: unknown;
  SPRIGR_PLATFORM_BASE?: unknown;
  SPRIGR_INSTALL_TOKEN?: unknown;
}

export interface HomeInvalidateOptions {
  /** Override the POST timeout (ms). */
  timeoutMs?: number;
  /** The fetch to use for the POST; defaults to the global one. */
  fetch?: typeof fetch;
}

interface HomeInvalidateBinding {
  invalidate(input: HomeInvalidateInput): Promise<HomeInvalidateResult>;
}

function bindingOf(env: HomeInvalidateEnv): HomeInvalidateBinding | null {
  try {
    const home = (env.SPRIGR as { home?: unknown } | undefined)?.home as Partial<HomeInvalidateBinding> | undefined;
    return typeof home?.invalidate === 'function' ? (home as HomeInvalidateBinding) : null;
  } catch {
    // A Home dispatch withholds a SPRIGR it did not build: reading it throws.
    return null;
  }
}

function fail(provider: string, error: string, extra: { status?: number; detail?: string } = {}): HomeInvalidateResult {
  console.warn(`[home-invalidate] ${provider}: ${error}${extra.status ? ` (${extra.status})` : ''}${extra.detail ? `: ${extra.detail}` : ''}`);
  return { ok: false, error, ...extra };
}

/**
 * Mark a Home provider's cached answers stale, so the next Home read asks the
 * app's Home tool again. Uses `env.SPRIGR.home.invalidate` when the handler
 * has it, otherwise POSTs to the platform with the install token. Resolves
 * `{ ok: false, error }` instead of throwing; `no_route` means neither path is
 * available (no binding and no install token).
 */
export async function invalidateHome(
  env: HomeInvalidateEnv,
  input: HomeInvalidateInput,
  opts: HomeInvalidateOptions = {},
): Promise<HomeInvalidateResult> {
  const provider = typeof input?.provider === 'string' ? input.provider : '?';
  let body;
  try {
    body = homeInvalidateBodyFor(input);
  } catch (err) {
    return fail(provider, 'invalid_input', { detail: (err as Error).message });
  }

  const binding = bindingOf(env);
  if (binding) {
    try {
      const res = await binding.invalidate(input);
      if (res && res.ok === false) return fail(provider, res.error ?? 'refused', { status: res.status, detail: res.detail });
      return { ok: true };
    } catch (err) {
      return fail(provider, 'binding_failed', { detail: (err as Error).message });
    }
  }

  const base = typeof env.SPRIGR_PLATFORM_BASE === 'string' ? env.SPRIGR_PLATFORM_BASE : '';
  const token = typeof env.SPRIGR_INSTALL_TOKEN === 'string' ? env.SPRIGR_INSTALL_TOKEN : '';
  if (!base || !token) return fail(provider, 'no_route');

  const doFetch = opts.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? HOME_INVALIDATE_TIMEOUT_MS);
  try {
    const res = await doFetch(`${base.replace(/\/+$/, '')}${HOME_INVALIDATE_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return fail(provider, 'http_error', { status: res.status });
    return { ok: true };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    return fail(provider, aborted ? 'timeout' : 'fetch_failed', { detail: (err as Error).message });
  } finally {
    clearTimeout(timer);
  }
}
