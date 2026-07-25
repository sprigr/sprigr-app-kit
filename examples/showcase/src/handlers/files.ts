/**
 * Showcase - env.SPRIGR.files.* reference module.
 *
 *   files.putStream  stream bytes into the app's enforced R2 prefix
 *                    (_apps/{installId}/...). A ReadableStream body is
 *                    streamed without buffering; a string/Blob is uploaded
 *                    directly. Use for report exports, generated CSVs, etc.
 *   files.url        mint a short-lived signed URL for a stored file. Re-mint
 *                    on demand rather than caching the URL.
 *
 * The document-engine read/write twins (files.edit / files.create /
 * files.extract) are NOT part of the marketplace wrapper — env.SPRIGR.files
 * exposes only putStream + url. For binary text extraction inside a workflow
 * use the platform's files.extract via the agent, not env.SPRIGR here.
 *
 * All staging-only.
 */

import { stagingOnly } from '../lib/env';
import type { ShowcaseEnv, HandlerOk, HandlerStagingOnly } from '../lib/env';

/** Upload a generated CSV report (string body). */
export async function putReportCsv(env: ShowcaseEnv, key: string, csv: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.files.putStream(key, csv, { contentType: 'text/csv', filename: 'acme-report.csv' }),
    'putReportCsv calls env.SPRIGR.files.putStream — publish to staging.',
  );
}

/** Stream a large export without buffering it in memory. */
export async function putReportStream(
  env: ShowcaseEnv,
  key: string,
  body: ReadableStream,
  length: number,
): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.files.putStream(key, body, { contentType: 'application/octet-stream', length }),
    'putReportStream streams via env.SPRIGR.files.putStream — publish to staging.',
  );
}

/** Mint a 1-hour signed URL for a stored file. */
export async function reportUrl(env: ShowcaseEnv, key: string): Promise<HandlerOk | HandlerStagingOnly> {
  return stagingOnly(
    () => env.SPRIGR.files.url(key, { expiresIn: 3600 }),
    'reportUrl calls env.SPRIGR.files.url — publish to staging.',
  );
}
