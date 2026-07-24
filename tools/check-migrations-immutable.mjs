#!/usr/bin/env node
// Guard: shipped migration files must never be MODIFIED, RENAMED, or DELETED.
//
// The build-runner records a sha256 of each migration file in a per-install
// ledger when it applies it. If the file's CONTENT later changes (even a
// comment), the ledger no longer matches and EVERY existing install is
// blocked from upgrading. This bit procore when PR #196's scope-rename
// codemod edited apps/procore/migrations/0002+0003 comments (and silently
// bricked shopify/simpro/realestate the same way).
//
// Rule: adding a NEW migration file is fine; editing, renaming, or deleting
// an EXISTING one is not. Renames and deletes are blocked by default — they
// orphan ledger entries and re-run under the new name. THE ONE EXCEPTION
// for edits: a byte-exact revert to the file's original (first-committed)
// content is allowed — that's the recovery move when a baseline got corrupted,
// and it restores the ledger-matching sha.
//
// Ledger-recovery rename (the second, allowlist-gated exception): when a
// migration's content changed while it was live and installs applied it at
// DIFFERENT byte contents, no single revert can match every install's ledger.
// The build-runner's own remedy is "rename the migration file (give it a
// fresh ledger entry)": under a new filename it is applied fresh everywhere,
// so it must be idempotent (IF NOT EXISTS on every statement). Such a rename
// passes this guard only when BOTH hold:
//   1. it is registered in tools/migration-ledger-renames.json
//      ({from, to, reason} with repo-relative paths), and
//   2. the new file is byte-identical to the old file at the base ref
//      (a pure ledger-key rename; schema changes still go in a new
//      numbered migration).
// The allowlist keeps accidental renames (codemods, cleanups) blocked: an
// entry with a written reason cannot happen by accident. VERIFY THE RENAMED
// MIGRATION IS IDEMPOTENT BEFORE REGISTERING IT — the guard cannot check that.
//
// Run in CI against the PR base, or locally: node tools/check-migrations-immutable.mjs <base-ref>
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const base = process.argv[2] || process.env.BASE_SHA || 'origin/main';
const ALLOWLIST_PATH = 'tools/migration-ledger-renames.json';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' });
}

// Registered ledger-recovery renames ({from, to, reason}). Sourced from the
// PR side of the diff (HEAD), so a recovery PR registers its own rename; the
// entry is loud in the diff and carries a written reason, which is the
// property the guard exists to enforce (no ACCIDENTAL renames).
//
// Read via `git show HEAD:` — NOT `import.meta.url` — because CI runs the
// guard from a copy under /tmp (so a PR cannot weaken the script and
// self-approve), where a path relative to the script would miss the repo
// file. Fall back to the working-tree file for local runs where the
// allowlist may not be committed yet.
function loadRenameAllowlist() {
  let raw = null;
  try {
    // stderr ignored: a missing file at HEAD (local run before the allowlist
    // is committed) is expected and handled by the working-tree fallback.
    raw = execSync(`git show HEAD:${ALLOWLIST_PATH}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    try {
      const root = sh('git rev-parse --show-toplevel').trim();
      raw = readFileSync(path.join(root, ALLOWLIST_PATH), 'utf8');
    } catch {
      return [];
    }
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && e.from && e.to && e.reason) : [];
  } catch {
    return [];
  }
}

// A rename (or delete+add pair) is an allowed ledger-recovery rename iff it
// is registered in the allowlist AND the new file is byte-identical to the
// old file's content at the base ref (pure ledger-key rename).
function isAllowedLedgerRename(allowlist, from, to) {
  const entry = allowlist.find((e) => e.from === from && e.to === to);
  if (!entry) return null;
  let oldContent, newContent;
  try {
    oldContent = sh(`git show ${base}:${from}`);
    newContent = sh(`git show HEAD:${to}`);
  } catch {
    return null; // can't prove byte-identity — treat as an offender
  }
  return oldContent === newContent ? entry : null;
}

// Check for MODIFIED migration files (content changes to existing files).
let modified = '';
try {
  modified = sh(
    `git diff --diff-filter=M --name-only ${base}...HEAD -- 'apps/*/migrations/*.sql'`,
  ).trim();
} catch (e) {
  console.error('migration-immutability check could not run git diff:', e.message);
  process.exit(2);
}

// Check for RENAMED or DELETED migration files. Both are unconditional violations:
// a rename changes the ledger key; a delete removes it entirely.
let renamedOrDeleted = '';
try {
  renamedOrDeleted = sh(
    `git diff --diff-filter=RD --name-status ${base}...HEAD -- 'apps/*/migrations/*.sql'`,
  ).trim();
} catch (e) {
  console.error('migration-immutability check could not run git diff (rename/delete):', e.message);
  process.exit(2);
}

if (!modified && !renamedOrDeleted) {
  console.log('OK: no shipped migration files were modified, renamed, or deleted.');
  process.exit(0);
}

// A modified migration is only acceptable if it's a byte-exact revert to its
// original (first-committed) content — the recovery move that restores the
// ledger sha. Anything else is a real edit and is blocked.
const offenders = [];
const reverts = [];
for (const f of modified.split('\n').filter(Boolean)) {
  let current = '';
  let original = null;
  try {
    current = sh(`git show HEAD:${f}`);
    const addCommit = sh(`git log --diff-filter=A --format=%H -- ${f}`).split('\n').filter(Boolean).pop();
    if (addCommit) original = sh(`git show ${addCommit}:${f}`);
  } catch {
    /* fall through — if we can't prove it's a revert, treat as an offender */
  }
  if (original !== null && current === original) reverts.push(f);
  else offenders.push(f);
}

// Renames and deletes are violations unless registered as a ledger-recovery
// rename (allowlisted + byte-identical under the new name). Depending on git's
// rename detection, a recovery rename shows up either as one R line or as a
// D line plus an A file — handle both.
const allowlist = loadRenameAllowlist();
let addedFiles = [];
try {
  addedFiles = sh(`git diff --diff-filter=A --name-only ${base}...HEAD -- 'apps/*/migrations/*.sql'`)
    .trim()
    .split('\n')
    .filter(Boolean);
} catch {
  /* leave empty — allowlisted deletes will then be treated as offenders */
}
const allowedRenames = [];
for (const line of renamedOrDeleted.split('\n').filter(Boolean)) {
  const parts = line.split('\t');
  const status = parts[0];
  if (status.startsWith('R')) {
    const [, from, to] = parts;
    const entry = isAllowedLedgerRename(allowlist, from, to);
    if (entry) allowedRenames.push({ from, to, reason: entry.reason });
    else offenders.push(`${from} (renamed to ${to})`);
  } else if (status === 'D') {
    const from = parts[1];
    const candidate = allowlist.find((e) => e.from === from && addedFiles.includes(e.to));
    const entry = candidate ? isAllowedLedgerRename(allowlist, from, candidate.to) : null;
    if (entry) allowedRenames.push({ from, to: entry.to, reason: entry.reason });
    else offenders.push(`${from} (deleted)`);
  }
}

if (reverts.length) {
  console.log(
    'Allowed byte-exact revert(s) to original content (recovery — restores the ledger sha):\n' +
      reverts.map((f) => '  ~ ' + f).join('\n'),
  );
}

if (allowedRenames.length) {
  console.log(
    'Allowed ledger-recovery rename(s) (registered in tools/migration-ledger-renames.json, byte-identical):\n' +
      allowedRenames.map((r) => `  ~ ${r.from} -> ${r.to} (${r.reason})`).join('\n'),
  );
}

if (offenders.length) {
  console.error(
    'ERROR: shipped migration file(s) were MODIFIED, RENAMED, or DELETED. Migrations are immutable\n' +
      'once shipped — editing, renaming, or deleting one corrupts the per-install ledger and blocks\n' +
      'every existing install from upgrading. Add a NEW migration (next number) instead of editing\n' +
      'an existing file. The only permitted edits are (a) a byte-exact revert to the original\n' +
      'content, or (b) a ledger-recovery rename registered in tools/migration-ledger-renames.json\n' +
      'with the new file byte-identical to the old one (see the header comment).\n\n' +
      'Offending files:\n' +
      offenders.map((f) => '  ' + f).join('\n'),
  );
  process.exit(1);
}

console.log('OK: shipped migration changes are all allowed recovery moves (byte-exact reverts and/or registered ledger-recovery renames).');
