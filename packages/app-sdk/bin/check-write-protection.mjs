#!/usr/bin/env node
/**
 * sprigr-check-write-protection: every destructive tool declares a policy.
 *
 * The platform cannot tell which of an app's tools are destructive (sprigr-team
 * decisions 0009 and 0011 both say so), so nothing platform-side can enforce
 * that a permanent delete is gated. The app repo can, by name: this scans every
 * `sprigr-app.json` and fails on a tool or enumerated dispatcher action whose
 * name is destructive and that carries no `confirmation` entry.
 *
 * Escape hatches, both explicit and reviewable:
 *
 *   apps/<app>/write-protection.json
 *     { "allow": { "<tool>": "<reason>", "<tool>:<action>": "<reason>" } }
 *     A destructive-by-name entry that is genuinely harmless (a read named
 *     `refund_rate`, a fixture reset). Every entry needs a reason. A stale
 *     entry fails, so the file cannot silently mask a tool that came back.
 *
 *   --baseline <file>   (default tools/write-protection-baseline.json if present)
 *     The ratchet. Violations listed in the baseline are reported but do not
 *     fail; anything new fails; a baseline entry that no longer violates fails
 *     too, so headroom is banked with --write-baseline rather than re-spent.
 *
 * A dispatcher tool that does not enumerate its actions (`dispatch.actions`
 * or an `enum` on the action field) cannot be inspected and is itself a
 * violation until enumerated or allowlisted.
 *
 * Dependency-free: Node stdlib only, like the other repo guards.
 *
 *   sprigr-check-write-protection [--apps apps] [--warn] [--baseline f] [--write-baseline]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A tool or action name that destroys, reverses money, or cannot be walked
 * back. Tested against the bare name and with any leading `<app>_` prefix
 * stripped, so `shopify_delete_product` and `delete_product` both match.
 */
export const DESTRUCTIVE_ACTION_PATTERN =
  /(^|_)(delete|remove|destroy|cancel|void|refund|unship|rotate|offboard|purge|wipe|drop|terminate|clear|reset|revoke|unregister|force|deactivate|suspend)(_|$)|(^|_)(capture_payment|complete_draft)/;

export function isDestructiveName(name) {
  return DESTRUCTIVE_ACTION_PATTERN.test(name);
}

function enumeratedActions(tool) {
  const d = tool.dispatch;
  if (d && d.actions) {
    if (Array.isArray(d.actions)) return d.actions.map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean);
    if (typeof d.actions === 'object') return Object.keys(d.actions);
  }
  const field = (d && d.actionField) || 'action';
  const prop = tool.input_schema && tool.input_schema.properties && tool.input_schema.properties[field];
  if (!prop) return null; // not a dispatcher
  if (Array.isArray(prop.enum)) return prop.enum.map(String);
  for (const k of ['oneOf', 'anyOf']) {
    if (Array.isArray(prop[k])) return prop[k].map((o) => o && o.const).filter(Boolean).map(String);
  }
  return []; // a dispatcher, but nothing enumerated
}

function isGatedRule(rule) {
  return !!rule && typeof rule === 'object' && (rule.always === true || !!rule.when);
}

/**
 * Violations for one manifest, as `tool` or `tool:action` strings.
 * Pure, so it is unit-testable without touching the filesystem.
 */
export function scanManifest(manifest) {
  const out = [];
  for (const tool of manifest.tools || []) {
    if (!tool || tool.internal) continue;
    const pol = tool.confirmation && typeof tool.confirmation === 'object' ? tool.confirmation : null;
    const toolGated = tool.confirmation_required === true || isGatedRule(pol);
    const actions = enumeratedActions(tool);
    if (actions === null) {
      if (isDestructiveName(tool.name) && !toolGated) out.push(tool.name);
      continue;
    }
    if (toolGated) continue;
    if (actions.length === 0) {
      out.push(`${tool.name}:<unenumerated>`);
      continue;
    }
    const perAction = (pol && pol.actions) || {};
    for (const a of actions) {
      if (isDestructiveName(a) && !isGatedRule(perAction[a])) out.push(`${tool.name}:${a}`);
    }
  }
  return out;
}

/** Apply the app's allowlist. Returns { violations, stale, unreasoned }. */
export function applyAllowlist(violations, allowlist) {
  const allow = (allowlist && allowlist.allow) || {};
  const unreasoned = Object.entries(allow).filter(([, r]) => typeof r !== 'string' || !r.trim()).map(([k]) => k);
  const remaining = violations.filter((v) => !(v in allow));
  const stale = Object.keys(allow).filter((k) => !violations.includes(k));
  return { violations: remaining, stale, unreasoned };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function run(argv, cwd = process.cwd()) {
  const args = [...argv];
  const opt = (flag, dflt) => {
    const i = args.indexOf(flag);
    if (i === -1) return dflt;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const has = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };
  const warnOnly = has('--warn');
  const writeBaseline = has('--write-baseline');
  const appsDir = opt('--apps', 'apps');
  const defaultBaseline = join(cwd, 'tools', 'write-protection-baseline.json');
  const baselinePath = opt('--baseline', existsSync(defaultBaseline) ? defaultBaseline : null);
  const baseline = baselinePath && existsSync(baselinePath) ? readJson(baselinePath) : {};

  const root = join(cwd, appsDir);
  const appDirs = existsSync(join(cwd, 'sprigr-app.json'))
    ? [{ slug: '.', dir: cwd }]
    : readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'sprigr-app.json')))
        .map((e) => ({ slug: e.name, dir: join(root, e.name) }));

  const failures = [];
  const report = [];
  const nextBaseline = {};

  for (const { slug, dir } of appDirs) {
    let manifest;
    try {
      manifest = readJson(join(dir, 'sprigr-app.json'));
    } catch (err) {
      failures.push(`${slug}: sprigr-app.json does not parse (${err.message})`);
      continue;
    }
    const allowPath = join(dir, 'write-protection.json');
    const allowlist = existsSync(allowPath) ? readJson(allowPath) : null;
    const raw = scanManifest(manifest);
    const { violations, stale, unreasoned } = applyAllowlist(raw, allowlist);
    for (const k of unreasoned) failures.push(`${slug}: write-protection.json allow entry "${k}" has no reason`);
    for (const k of stale) failures.push(`${slug}: write-protection.json allow entry "${k}" is stale (no longer destructive-and-ungated); remove it`);

    const known = new Set(baseline[slug] || []);
    const fresh = violations.filter((v) => !known.has(v));
    const banked = [...known].filter((v) => !violations.includes(v));
    if (violations.length) nextBaseline[slug] = violations.sort();

    for (const v of fresh) failures.push(`${slug}: ${v} is destructive by name and declares no confirmation policy`);
    for (const v of banked) failures.push(`${slug}: baseline lists "${v}" but it is now gated or gone; run --write-baseline to bank the headroom`);
    report.push(`${slug.padEnd(28)} destructive-ungated=${String(violations.length).padStart(3)} (new ${fresh.length}, baselined ${violations.length - fresh.length})`);
  }

  if (writeBaseline && baselinePath) {
    writeFileSync(baselinePath, JSON.stringify(nextBaseline, null, 2) + '\n');
    return { code: 0, lines: [...report, `wrote ${baselinePath}`] };
  }

  const lines = [...report];
  if (failures.length) {
    lines.push('', `${failures.length} write-protection finding(s):`, ...failures.map((f) => `  ${f}`));
    lines.push(
      '',
      'Fix: add a `confirmation` policy to the tool (or `confirmation.actions[<action>]` on a dispatcher),',
      'or record a reason in apps/<app>/write-protection.json under "allow". See @sprigr/apps-app-sdk README, "Write protection".',
    );
    return { code: warnOnly ? 0 : 1, lines };
  }
  lines.push(`OK: ${appDirs.length} app manifest(s), no unguarded destructive tools outside the baseline.`);
  return { code: 0, lines };
}

const invokedDirectly = process.argv[1] && /check-write-protection\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const { code, lines } = run(process.argv.slice(2));
  for (const l of lines) (code ? console.error : console.log)(l);
  process.exit(code);
}
