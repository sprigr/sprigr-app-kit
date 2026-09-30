/**
 * gh#9386: `putAppFileStream`'s single-shot POST meant a transient R2 fault
 * (502 `put_failed`, Cloudflare code 10001/10043) permanently lost a
 * resendable buffered body (the platform's own put-stream route cannot
 * retry — its body is already spent by the time an error reaches it). A
 * `Uint8Array`/`ArrayBuffer`/`Blob` body is safe to resend against the same
 * deterministic key, so the SDK retries it instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { putAppFileStream } from '../src/app-files';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('putAppFileStream retry (gh#9386)', () => {
  it('retries a resendable body twice on a transient R2 502 (10001), then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) {
        return jsonResponse(502, {
          error: 'put_failed',
          detail: 'put: We encountered an internal error. Please try again. (10001)',
        });
      }
      return jsonResponse(200, { ok: true, key: 'maximo-files/W1/a.jpg', bytes: 3, contentType: 'image/jpeg' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await putAppFileStream(
      { SPRIGR_INSTALL_TOKEN: 'tok' },
      { key: 'maximo-files/W1/a.jpg', body: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' },
    );

    expect(result).toMatchObject({ ok: true, key: 'maximo-files/W1/a.jpg' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('gives up after exhausting retries and throws the last error', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(502, { error: 'put_failed', detail: 'put: internal error (10001)' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      putAppFileStream(
        { SPRIGR_INSTALL_TOKEN: 'tok' },
        { key: 'maximo-files/W1/a.jpg', body: new Uint8Array([1]) },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('does NOT retry a ReadableStream body — it is sent once even on a transient 502', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(502, { error: 'put_failed', detail: 'put: internal error (10001)' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    await expect(
      putAppFileStream({ SPRIGR_INSTALL_TOKEN: 'tok' }, { key: 'maximo-files/W1/a.jpg', body: stream }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 400 (caller error)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'invalid_key' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      putAppFileStream({ SPRIGR_INSTALL_TOKEN: 'tok' }, { key: '../escape', body: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 413 (size cap)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(413, { error: 'too_large' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      putAppFileStream({ SPRIGR_INSTALL_TOKEN: 'tok' }, { key: 'maximo-files/W1/a.jpg', body: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on a bare 503 with no matching detail', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(503, { error: 'unavailable' });
      return jsonResponse(200, { ok: true, key: 'maximo-files/W1/a.jpg', bytes: 1, contentType: 'image/jpeg' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await putAppFileStream(
      { SPRIGR_INSTALL_TOKEN: 'tok' },
      { key: 'maximo-files/W1/a.jpg', body: new Uint8Array([1]) },
    );
    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('does NOT retry a 502 whose detail does not match a known transient R2 fault', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(502, { error: 'put_failed', detail: 'put: some other failure' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      putAppFileStream({ SPRIGR_INSTALL_TOKEN: 'tok' }, { key: 'maximo-files/W1/a.jpg', body: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
