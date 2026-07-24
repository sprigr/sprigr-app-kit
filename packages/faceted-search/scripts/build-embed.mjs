#!/usr/bin/env node
/**
 * build-embed - bundle the standalone faceted-search embed.
 *
 * Produces a single self-contained IIFE at dist/facet-browse.js that exposes a
 * global `SprigrFacetBrowse` ({ mount, unmount }). react + react-dom are aliased
 * to preact/compat so the whole UI plus renderer fits in one small file. CSS is
 * inlined by the component (a <style> tag), so there is no separate stylesheet.
 *
 * The bundle is a COMMITTED artifact, published to the Sprigr-hosted embeds
 * site by scripts/publish-embed.mjs (this repo is private, so agents fetch
 * https://sprigr-hq-embeds.sites.sprigr.com/facet-browse/v1/facet-browse.js
 * rather than a raw GitHub URL). To keep the committed copy honest:
 *
 *   node scripts/build-embed.mjs           # rebuild dist/facet-browse.js
 *   node scripts/build-embed.mjs --check   # rebuild to a temp buffer and diff;
 *                                           # exit 1 if dist is stale (CI gate)
 *
 * The --check mode mirrors tools/sync-vendor.mjs --check: it never writes when
 * the committed file already matches, and fails the build when it drifts.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(PKG_ROOT, 'embed', 'mount.ts');
const OUT_FILE = join(PKG_ROOT, 'dist', 'facet-browse.js');

const CHECK_ONLY = process.argv.includes('--check');

async function bundle() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    globalName: 'SprigrFacetBrowse',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    write: false,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    // Alias React onto preact/compat so the whole UI + renderer is one file.
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/client': 'preact/compat/client',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: PKG_ROOT,
  });
  return result.outputFiles[0].text;
}

const header =
  '/* @sprigr/apps-faceted-search embed bundle - GENERATED, do not edit.\n' +
  ' * Rebuild with: node packages/faceted-search/scripts/build-embed.mjs\n' +
  ' * Exposes window.SprigrFacetBrowse = { mount, unmount }. */\n';

const code = await bundle();
const contents = header + code;

if (CHECK_ONLY) {
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
  if (current !== contents) {
    console.error(
      '[build-embed] DRIFT: dist/facet-browse.js is stale - run ' +
        '`pnpm --filter @sprigr/apps-faceted-search build:embed` and commit the result.',
    );
    process.exit(1);
  }
  console.log('[build-embed] check OK - dist/facet-browse.js matches source.');
} else {
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, contents);
  console.log(`[build-embed] wrote ${OUT_FILE} (${(contents.length / 1024).toFixed(1)} KB)`);
}
