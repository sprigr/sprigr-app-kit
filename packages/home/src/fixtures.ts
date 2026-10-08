/**
 * Home Contracts: the publish-time check of each provider's fixtures file
 * (FINAL-APP-FEEDS 4.3 rule 11).
 *
 * A fixtures file is a JSON array of `{ name, request, vendor?, expect }`
 * cases. Every case must be a valid request for that provider and a valid
 * answer to it, with no record the platform would drop. The file must cover
 * the states Home draws differently: `ok`, `empty` and `not_connected`, plus
 * `unmapped` when the provider sets `requires_person`.
 *
 * Fixtures are rendered to tenants who never installed the app (Worth
 * connecting, section 11), so their display strings must already be what the
 * Home sanitizer would leave untouched: no markup, no URL, no emoji, no "!".
 *
 * Self-contained, so it lifts into `@sprigr/apps-home` unchanged.
 */

import type { HomeState } from './vocabulary';
import { checkHomeAnswer, homeRequestProblems, HOME_RECORD_FIELDS } from './records';
import { forEachHomeDisplayString, isPlainHomeObject } from './schema';
import type { HomeBlock, HomeRequest } from './types';

/** Not stated by the spec: a bound so one file cannot hold an unbounded case list. */
export const HOME_FIXTURE_MAX_CASES = 50;
const CASE_KEYS = ['name', 'request', 'vendor', 'expect'] as const;
const CASE_NAME_MAX = 80;

/** `containsMarkup` in agent-core's app-card sanitizer: '<' followed by a letter starts a tag. */
const MARKUP_RX = /<[a-zA-Z]/;
/** Anything with a scheme, or a leading www. (section 9). */
const URL_RX = /[a-z][a-z0-9+.-]*:\/\/|\bwww\./i;
const EMOJI_RX = /\p{Extended_Pictographic}/u;

/**
 * Why the Home sanitizer would change `text`, or null when it would leave it
 * as is. The sanitizer itself (strip and replace on read) is a later slice;
 * at publish the rule refuses instead.
 */
export function homeDisplayTextProblem(text: string): string | null {
  if (MARKUP_RX.test(text)) return 'must not contain markup';
  if (URL_RX.test(text)) return 'must not contain a URL';
  if (EMOJI_RX.test(text)) return 'must not contain emoji';
  if (text.includes('!')) return 'must not contain "!" (the sanitizer turns it into ".")';
  return null;
}

/** The states every provider's fixtures must cover. */
export function requiredFixtureStates(requiresPerson: boolean): HomeState[] {
  return requiresPerson ? ['ok', 'empty', 'not_connected', 'unmapped'] : ['ok', 'empty', 'not_connected'];
}

/**
 * Check every provider's fixtures file. `readFile` returns a file's text from
 * the upload, or undefined when it is not there. Returns the first refusal,
 * or null.
 */
export function validateHomeFixtures(block: HomeBlock, readFile: (path: string) => string | undefined): string | null {
  const linkIds = (block.links ?? []).map((l) => l.id);
  for (let i = 0; i < block.provides.length; i += 1) {
    const provider = block.provides[i];
    if (!provider) continue;
    const file = provider.fixtures;
    const at = `home.provides[${i}].fixtures "${file}"`;
    const text = readFile(file);
    if (text === undefined) return `${at} is not in the upload`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `${at} is not valid JSON`;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return `${at} must be a non-empty JSON array of { name, request, vendor, expect } cases`;
    }
    if (parsed.length > HOME_FIXTURE_MAX_CASES) return `${at} has ${parsed.length} cases; max ${HOME_FIXTURE_MAX_CASES}`;

    const names = new Set<string>();
    const states = new Set<string>();
    for (let c = 0; c < parsed.length; c += 1) {
      const fc = parsed[c];
      const where = `${at} case ${c}`;
      if (!isPlainHomeObject(fc)) return `${where} must be an object`;
      for (const key of Object.keys(fc)) {
        if (!(CASE_KEYS as readonly string[]).includes(key)) return `${where} has unknown key "${key}"; allowed: ${CASE_KEYS.join(', ')}`;
      }
      if (typeof fc.name !== 'string' || fc.name.trim() === '' || fc.name.length > CASE_NAME_MAX) {
        return `${where}.name must be a non-empty string of at most ${CASE_NAME_MAX} characters`;
      }
      const named = `${at} case "${fc.name}"`;
      if (names.has(fc.name)) return `${named} is named twice`;
      names.add(fc.name);

      const reqProblems = homeRequestProblems(fc.request);
      if (reqProblems.length > 0) return `${named}: ${reqProblems[0]}`;
      const request = fc.request as HomeRequest;
      if (request.contract !== provider.contract) {
        return `${named}: request.contract must be ${provider.contract}, the provider's contract`;
      }
      if (request.provider !== provider.id) return `${named}: request.provider must be "${provider.id}"`;
      if (request.scope !== provider.scope) return `${named}: request.scope must be ${provider.scope}, the provider's scope`;
      if (request.mode?.kind && provider.modes && !provider.modes.includes(request.mode.kind)) {
        return `${named}: request.mode ${request.mode.kind} is not in the provider's declared modes`;
      }

      const check = checkHomeAnswer(provider.contract, fc.expect, { request, provider, linkIds }, 'expect');
      if (check.problems.length > 0) return `${named}: ${check.problems[0]}`;
      const dropped = check.dropped[0];
      if (dropped) {
        return `${named}: expect.records[${dropped.index}] would be dropped by the platform: ${dropped.problems[0] ?? 'invalid'}`;
      }
      const recordSpec = { type: 'object' as const, fields: HOME_RECORD_FIELDS[provider.contract] };
      const dirty: string[] = [];
      check.records.forEach((rec, r) => {
        forEachHomeDisplayString(rec, recordSpec, `expect.records[${r}]`, (s, path) => {
          const why = homeDisplayTextProblem(s);
          if (why) dirty.push(`${path} ${why}`);
        });
      });
      if (dirty[0]) return `${named}: ${dirty[0]}`;
      states.add((fc.expect as { state: string }).state);
    }
    for (const s of requiredFixtureStates(provider.requires_person === true)) {
      if (!states.has(s)) return `${at} has no "${s}" case; fixtures must cover ${requiredFixtureStates(provider.requires_person === true).join(', ')}`;
    }
  }
  return null;
}
