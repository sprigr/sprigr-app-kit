#!/usr/bin/env node
/**
 * Copy the kit's stylesheets into dist/ alongside the tsup JS output.
 *
 * tsup only emits the JS/d.ts entry; the CSS layer is plain hand-authored CSS
 * that ships verbatim, so the package's `exports` can point every entry at
 * dist/ and `files` can stay `["dist", "README.md"]` like its siblings.
 *
 * The relative `@import "./tokens.css"` inside index.css keeps working because
 * the whole styles/ directory is copied as a unit.
 *
 * Run via `pnpm build` (tsup && node scripts/copy-styles.mjs).
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(pkgRoot, 'src/styles');
const dest = resolve(pkgRoot, 'dist/styles');

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

const copied = (await readdir(dest)).sort();
console.log(`copy-styles: ${copied.length} file(s) -> dist/styles (${copied.join(', ')})`);
