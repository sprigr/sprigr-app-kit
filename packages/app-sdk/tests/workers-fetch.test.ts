import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKERS_REDIRECT_ERROR } from './helpers/workers-fetch';

const ok = async () => new Response('ok');

describe('the suite-wide Workers fetch guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses redirect: error through vi.stubGlobal, like Workers', async () => {
    const mock = vi.fn(ok);
    vi.stubGlobal('fetch', mock);
    await expect(fetch('https://files.sprigr.com/x', { redirect: 'error' })).rejects.toThrow(WORKERS_REDIRECT_ERROR);
    expect(mock).not.toHaveBeenCalled();
    await expect(fetch('https://files.sprigr.com/x', { redirect: 'manual' })).resolves.toBeInstanceOf(Response);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('refuses it through a direct globalThis.fetch assignment too', async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = ok as typeof globalThis.fetch;
      await expect(fetch('https://files.sprigr.com/x', { redirect: 'error' })).rejects.toThrow(TypeError);
      await expect(fetch(new Request('https://files.sprigr.com/x', { redirect: 'error' }))).rejects.toThrow(WORKERS_REDIRECT_ERROR);
      await expect(fetch('https://files.sprigr.com/x')).resolves.toBeInstanceOf(Response);
    } finally {
      globalThis.fetch = original;
    }
  });
});
