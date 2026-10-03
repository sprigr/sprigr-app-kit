/**
 * Content policy, the extract bridge, the pending-extraction drain, and the
 * validated import. Same caps as both apps; the truncation marker is new.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_TRUNCATION_MARKER,
  EXTRACT_STAGING_PREFIX,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_CHARS,
  MAX_EXTRACT_INLINE_BYTES,
  buildExtractJobToken,
  capText,
  extractFormatForMime,
  isTextLikeMimeType,
} from '../src/content';
import { importFileObjects, partitionValidObjects } from '../src/import';
import { indexActorFiles } from '../src/indexer';
import { drainPendingExtractions, refreshPendingExtractions } from '../src/pending';
import { rig } from './helpers/setup';

const PDF = 'application/pdf';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const bytes = (s: string) => new TextEncoder().encode(s);

describe('classification and caps', () => {
  it('maps OOXML/PDF to extract formats and nothing else', () => {
    expect(extractFormatForMime(PDF)).toBe('pdf');
    expect(extractFormatForMime('APPLICATION/PDF')).toBe('pdf');
    expect(extractFormatForMime(PPTX)).toBe('pptx');
    expect(extractFormatForMime('application/msword')).toBeNull();
    expect(extractFormatForMime('image/png')).toBeNull();
    expect(isTextLikeMimeType('text/x-python')).toBe(true);
    expect(isTextLikeMimeType('application/json')).toBe(true);
    expect(isTextLikeMimeType(PDF)).toBe(false);
  });
  it('keeps the existing caps', () => {
    expect([MAX_CONTENT_BYTES, MAX_CONTENT_CHARS, MAX_EXTRACT_INLINE_BYTES]).toEqual([256 * 1024, 32000, 16 * 1024 * 1024]);
  });
  it('never cuts silently: the stored value ends with the marker and stays inside the cap', () => {
    expect(capText('short')).toBe('short');
    const cut = capText('x'.repeat(40000), { what: 'gw:file:big' });
    expect(cut.length).toBe(MAX_CONTENT_CHARS);
    expect(cut.endsWith(CONTENT_TRUNCATION_MARKER)).toBe(true);
    const engineCut = capText('y'.repeat(MAX_CONTENT_CHARS), { alreadyTruncated: true });
    expect(engineCut.length).toBe(MAX_CONTENT_CHARS);
    expect(engineCut.endsWith(CONTENT_TRUNCATION_MARKER)).toBe(true);
  });
  it('reproduces both apps extraction job tokens byte for byte', async () => {
    const secret = 'a'.repeat(64);
    const ref = (msg: string[], prefix: string) =>
      prefix + createHmac('sha256', secret).update(msg.join('\u0000')).digest('hex').slice(0, 40);
    expect(
      await buildExtractJobToken(secret, { namespace: 'gws-extract-job', tokenPrefix: 'gwx-', ids: ['F1'], format: 'pptx', version: 'v9' }),
    ).toBe(ref(['gws-extract-job', 'v1', 'F1', 'pptx', 'v9'], 'gwx-'));
    expect(
      await buildExtractJobToken(secret, {
        namespace: 'ms365-extract-job',
        tokenPrefix: 'msx-',
        ids: ['D1', 'I1'],
        format: 'pdf',
        version: undefined,
      }),
    ).toBe(ref(['ms365-extract-job', 'v1', 'D1', 'I1', 'pdf', ''], 'msx-'));
  });
});

describe('enrichment inside a pass', () => {
  it('fills text, native exports and binaries; skips oversize; stages under random keys and deletes them', async () => {
    const r = await rig('drive');
    r.src.put({ id: 't', name: 't.txt', mime: 'text/plain', content: 'hello', perms: [] });
    r.src.put({ id: 'big', name: 'big.txt', mime: 'text/plain', content: 'never read', size: MAX_CONTENT_BYTES + 1, perms: [] });
    r.src.put({ id: 'doc', name: 'Doc', mime: 'application/vnd.google-apps.document', content: 'native', perms: [] });
    r.src.put({ id: 'p', name: 'p.pdf', mime: PDF, perms: [] });
    r.src.put({ id: 'huge', name: 'h.pdf', mime: PDF, size: MAX_EXTRACT_INLINE_BYTES, perms: [] });
    r.src.put({ id: 'long', name: 'l.txt', mime: 'text/plain', content: 'z'.repeat(40000), perms: [] });
    r.src.binary.set('p', bytes('pdf text'));
    r.src.pageSize = 10;
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    const content = (id: string) => r.fp.acl.get(`gw:file:${id}`)!.content;
    expect(content('t')).toBe('hello');
    expect(content('big')).toBe('');
    expect(content('doc')).toBe('exported:native');
    expect(content('p')).toBe('pdf text');
    expect(content('huge')).toBe('');
    expect(String(content('long')).endsWith(CONTENT_TRUNCATION_MARKER)).toBe(true);
    expect(r.fp.extractCalls).toHaveLength(1);
    const key = r.fp.extractCalls[0]!.file_key;
    expect(key.startsWith(EXTRACT_STAGING_PREFIX)).toBe(true);
    expect(key).not.toContain('p.pdf');
    expect(r.fp.stagedDeletes).toEqual([key]);
    expect(r.fp.staged.size).toBe(0);
  });

  it('extracts at most five binaries per pass, the rest stay metadata-only', async () => {
    const r = await rig('drive');
    r.src.pageSize = 10;
    for (let i = 0; i < 7; i++) {
      r.src.put({ id: `p${i}`, name: `${i}.pdf`, mime: PDF, perms: [] });
      r.src.binary.set(`p${i}`, bytes(`t${i}`));
    }
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(r.fp.extractCalls).toHaveLength(5);
  });

  it('stops asking a throttled drive for content for the rest of the pass', async () => {
    const r = await rig('drive');
    r.src.pageSize = 10;
    r.src.put({ id: 'a', name: 'a.txt', mime: 'text/plain', perms: [] });
    r.src.put({ id: 'b', name: 'b.txt', mime: 'text/plain', perms: [] });
    let asked = 0;
    const adapter = { ...r.adapter, downloadText: async () => (asked++, { text: '', throttled: true }) };
    await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(asked).toBe(1);
  });
});

describe('deferred extractions', () => {
  it('records a pptx job, then the drain attaches its text to the latest metadata', async () => {
    const r = await rig('drive');
    r.src.put({ id: 's', name: 'deck.pptx', mime: PPTX, perms: ['bob@corp.com'] });
    r.src.binary.set('s', bytes('slides'));
    const adapter = { ...r.adapter, extractJobToken: async () => 'gwx-fixed' };
    await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    const [pending] = await r.store.listPendingExtractions(5);
    expect(pending).toMatchObject({ object_id: 'gw:file:s', job_token: 'gwx-fixed', format: 'pptx' });
    expect(r.fp.extractCalls[0]!.job_token).toBe('gwx-fixed');

    // sprigr-apps#2291: bob loses access before the job finishes, and this walk
    // re-imports the file WITHOUT re-extracting it (here: no binary download).
    // The import refreshes the stored record, so the drain cannot put bob back.
    r.src.touch('s', { perms: [] });
    await indexActorFiles({ ...adapter, downloadBinary: undefined }, r.store, r.fp.env, r.scope);
    expect(r.fp.extractCalls).toHaveLength(1);
    const [refreshed] = await r.store.listPendingExtractions(5);
    expect(JSON.parse(refreshed!.record_json).acl_principals).toEqual(['user:alice@corp.com']);

    r.fp.jobs.set('gwx-fixed', { status: 'done', result: { ok: true, text: 'slide text' } });
    expect(await drainPendingExtractions(r.store, r.fp.env)).toBe(1);
    expect(r.fp.acl.get('gw:file:s')).toMatchObject({ content: 'slide text', acl_principals: ['user:alice@corp.com'] });
    expect(await r.store.listPendingExtractions(5)).toEqual([]);
  });

  it('bumps a running job, drops a failed one, and drops a record that can never import', async () => {
    const r = await rig('drive');
    const rec = (p: string[]) => JSON.stringify({ objectID: 'gw:file:x', acl_principals: p });
    await r.store.upsertPendingExtraction({ objectId: 'gw:file:run', jobToken: 'run', recordJson: rec(['user:a@b.c']), format: 'pptx' });
    await r.store.upsertPendingExtraction({ objectId: 'gw:file:err', jobToken: 'err', recordJson: rec(['user:a@b.c']), format: 'pptx' });
    await r.store.upsertPendingExtraction({ objectId: 'gw:file:bad', jobToken: 'bad', recordJson: rec([]), format: 'pptx' });
    r.fp.jobs.set('run', { status: 'running' });
    r.fp.jobs.set('err', { status: 'error' });
    r.fp.jobs.set('bad', { status: 'done', result: { ok: true, text: 't' } });
    expect(await drainPendingExtractions(r.store, r.fp.env)).toBe(0);
    const left = await r.store.listPendingExtractions(5);
    expect(left.map((x) => [x.object_id, x.attempts])).toEqual([['gw:file:run', 1]]);
    expect(r.fp.imports).toEqual([]);
  });

  it('stops starting polls when its own slice is spent', async () => {
    const r = await rig('drive');
    await r.store.upsertPendingExtraction({ objectId: 'a', jobToken: 'a', recordJson: '{}', format: 'pptx' });
    const n = await drainPendingExtractions(r.store, r.fp.env, { budgetMs: 500 });
    expect(n).toBe(0);
    expect((await r.store.listPendingExtractions(5))[0]!.attempts).toBe(0);
  });

  it('sprigr-app-kit#99: minItemMs 0 never starts a row with exactly 0 ms left, and starts one with 1 ms', async () => {
    const r = await rig('drive');
    await r.store.upsertPendingExtraction({ objectId: 'a', jobToken: 'a', recordJson: '{}', format: 'pptx' });
    r.fp.jobs.set('a', { status: 'running' });
    // Regression: 0.1.0 compared `remaining < minItemMs`, so 0 < 0 was false
    // and the row started at the deadline itself.
    await drainPendingExtractions(r.store, r.fp.env, { deadline: { at: 1_000 }, now: () => 1_000, minItemMs: 0 });
    expect((await r.store.listPendingExtractions(5))[0]!.attempts).toBe(0);
    // One whole millisecond left: polled (and bumped, the job still running).
    await drainPendingExtractions(r.store, r.fp.env, { deadline: { at: 1_001 }, now: () => 1_000, minItemMs: 0 });
    expect((await r.store.listPendingExtractions(5))[0]!.attempts).toBe(1);
    // minItemMs 1 behaves the same at both edges.
    await drainPendingExtractions(r.store, r.fp.env, { deadline: { at: 1_000 }, now: () => 1_000, minItemMs: 1 });
    expect((await r.store.listPendingExtractions(5))[0]!.attempts).toBe(1);
    await drainPendingExtractions(r.store, r.fp.env, { deadline: { at: 1_001 }, now: () => 1_000, minItemMs: 1 });
    expect((await r.store.listPendingExtractions(5))[0]!.attempts).toBe(2);
  });

  it('refreshPendingExtractions drops the job of a file this walk already extracted', async () => {
    const r = await rig('drive');
    await r.store.upsertPendingExtraction({ objectId: 'gw:file:q', jobToken: 'q', recordJson: '{}', format: 'pdf' });
    await refreshPendingExtractions(r.store, [{ objectID: 'gw:file:q', acl_principals: ['user:a@b.c'], content: 'fresh' }]);
    expect(await r.store.listPendingExtractions(5)).toEqual([]);
  });
});

describe('validated import', () => {
  it('never sends a row whose principals fail, and normalises the rest', async () => {
    const r = await rig('drive');
    const n = await importFileObjects(r.fp.env, [
      { objectID: 'ok', acl_principals: ['user:Bob@Corp.com'] },
      { objectID: 'empty', acl_principals: [] },
      { objectID: 'space', acl_principals: ['user:a b@c.d'] },
    ]);
    expect(n).toBe(1);
    expect(r.fp.imports).toEqual([[{ objectID: 'ok', acl_principals: ['user:bob@corp.com'] }]]);
    expect(partitionValidObjects([{ objectID: '', acl_principals: ['public'] }]).rejected).toEqual(['']);
    await expect(importFileObjects({}, [{ objectID: 'x', acl_principals: ['public'] }])).rejects.toThrow(/data_unavailable/);
  });
});
