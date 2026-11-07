/**
 * sprigr-team#13478: a binary backlog drains at the per-pass binary cap, and a
 * row the cap cannot fill costs no source call.
 *
 * On LSR's Dropbox (2026-11-04) each drain read 200 rows, re-read every one
 * from Dropbox and resolved its permissions, then left all but 5 waiting on
 * MAX_EXTRACTIONS_PER_RUN: 217 `refetchEntry` calls (119 s summed) per tick
 * for 5 files filled, with about 33,500 files waiting for text.
 */
import { describe, expect, it } from 'vitest';
import { MAX_EXTRACTIONS_PER_RUN } from '../src/content';
import { CONTENT_FILL_CONCURRENCY, IDLE_CONTENT_FILL_MAX_BINARIES } from '../src/content-fill';
import { indexActorFiles } from '../src/indexer';
import type { FileSourceAdapter } from '../src/types';
import type { FakeFile } from './helpers/fake-source';
import { clock, rig, type Rig } from './helpers/setup';

const PDF = 'application/pdf';
const PASS_MS = 60_000;

/** The Dropbox fake with a counted `refetchEntry`. */
function counted(r: Rig): { adapter: FileSourceAdapter<FakeFile>; refetches: () => number } {
  let n = 0;
  return {
    adapter: {
      ...r.adapter,
      async refetchEntry(o) {
        n++;
        return r.src.files.get(String(o.fileId)) ?? null;
      },
    },
    refetches: () => n,
  };
}

function seedPdfs(r: Rig, n: number): void {
  r.src.pageSize = 1_000;
  for (let i = 0; i < n; i++) {
    const id = `p${String(i).padStart(3, '0')}`;
    r.src.put({ id, name: `${id}.pdf`, mime: PDF, perms: [] });
    r.src.binary.set(id, new TextEncoder().encode(`text ${id}`));
  }
}

const pass = (r: Rig, adapter: FileSourceAdapter<FakeFile>, c: ReturnType<typeof clock>) =>
  indexActorFiles(adapter, r.store, r.fp.env, r.scope, { deadline: { at: c.now() + PASS_MS }, now: c.now });

describe('sprigr-team#13478: the content-fill drain and the binary cap', () => {
  it('a drain whose binary cap is already spent re-reads no row', async () => {
    const r = await rig('dropbox');
    seedPdfs(r, 40);
    const c = clock();
    const { adapter, refetches } = counted(r);
    const first = await pass(r, adapter, c);
    // The walk spent the cap, so the drain at the end of this pass fills nothing.
    expect(r.fp.extractCalls).toHaveLength(MAX_EXTRACTIONS_PER_RUN);
    expect(first).toMatchObject({ contentDeferred: 40 - MAX_EXTRACTIONS_PER_RUN, contentPending: 40 - MAX_EXTRACTIONS_PER_RUN });
    expect(refetches()).toBe(0);
  });

  it('an idle drain fills up to its own binary cap, re-reading only the rows it can fill', async () => {
    const r = await rig('dropbox');
    seedPdfs(r, 40);
    const c = clock();
    const { adapter, refetches } = counted(r);
    await pass(r, adapter, c);
    const before = refetches();
    c.advance(15 * 60_000);

    const second = await pass(r, adapter, c);
    expect(IDLE_CONTENT_FILL_MAX_BINARIES).toBeGreaterThan(MAX_EXTRACTIONS_PER_RUN);
    expect(second).toMatchObject({
      contentFilled: IDLE_CONTENT_FILL_MAX_BINARIES,
      contentPending: 40 - MAX_EXTRACTIONS_PER_RUN - IDLE_CONTENT_FILL_MAX_BINARIES,
    });
    // Rows already in flight when the cap is reached may finish their re-read;
    // no further row is read.
    expect(refetches() - before).toBeLessThanOrEqual(IDLE_CONTENT_FILL_MAX_BINARIES + CONTENT_FILL_CONCURRENCY - 1);
  });
});
