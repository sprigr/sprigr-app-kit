/**
 * @sprigr/apps-file-sweep
 *
 * A bounded, resumable sweep of an app's own env.SPRIGR.files store, deleting
 * entries past their life. The app says which keys are its to judge and when
 * one has expired; the package walks, counts, caps and resumes.
 *
 *   const result = await runFileSweep({
 *     files: env.SPRIGR.files,
 *     prefixes: ['read_file/'],
 *     classify: (key) => (OFFLOAD_KEY.test(key) ? 'read_file' : null),
 *     isExpired: (uploadedMs, startedAt) => uploadedMs + LIFE_MS < startedAt,
 *     mode: 'delete',
 *     walkId: new Date().toISOString().slice(0, 10),
 *     state: { read: () => getSetting(db, KEY), write: (raw) => setSetting(db, KEY, raw) },
 *   });
 *   if (result.finished_now) log(summarise(result.state));
 *
 * See `file-sweep.ts` for the walk, the bounds and what it never deletes.
 */

export {
  runFileSweep,
  parseFileSweepState,
  addTally,
  totalOf,
  emptyTally,
  DEFAULT_MAX_LISTINGS_PER_TICK,
  DEFAULT_MAX_DELETES_PER_TICK,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_SAMPLE_SIZE,
} from './file-sweep';
export type {
  FileSweepMode,
  FileSweepOptions,
  FileSweepResult,
  FileSweepState,
  FileSweepStateStore,
  SweepFileEntry,
  SweepFilesApi,
  Tally,
} from './file-sweep';
