/**
 * The manifest `setup` block (sprigr-team decision 0406): its types and the
 * publish rules, twin of sprigr-team's validateManifestSetup. Both suites read
 * tests/fixtures/setup-block-fixtures.json, the same file in both repos, so a
 * manifest an app checks here gets the platform's verdict and message.
 */
/** The closed list of slots: a role in a business that one app fills. */
export const SETUP_SLOTS = [
  'email',
  'calendar',
  'files',
  'accounting',
  'job-management',
  'store',
  'inventory',
  'marketing',
  'support',
  'shipping',
  'tasks',
] as const;

export type SetupSlot = (typeof SETUP_SLOTS)[number];

/** A plain, non-secret value the person types before the connect tool runs
 *  (a site address, a shop domain). There is no secret input kind. */
export interface SetupConnectInput {
  /** A property of the connect tool's input_schema. */
  name: string;
  label: string;
  placeholder?: string;
}

/** Sign in at the vendor: the tool that starts the connection. */
export interface SetupConnectTool {
  tool: string;
  inputs?: SetupConnectInput[];
}

/** A key or password is typed on the app's own page, never in the guide:
 *  a sub-path of the installed app's page, starting "/". */
export interface SetupConnectPage {
  page: string;
}

export type SetupConnect = SetupConnectTool | SetupConnectPage;

export interface SetupStarterQuestion {
  slot: SetupSlot;
  text: string;
}

/** An offer only: nothing is created at install. Runs in the person's timezone. */
export interface SetupStarterRoutine {
  name: string;
  slot: SetupSlot;
  title: string;
  description: string;
  cron: string;
  prompt: string;
}

export interface SetupStarterBuild {
  slot: SetupSlot;
  text: string;
}

export interface SetupBlock {
  /** One or more distinct slots this app fills. */
  slots: SetupSlot[];
  /** Needs no outside account, so there is no connect step. */
  built_in?: boolean;
  /** Exactly one shape, absent only when built_in. */
  connect?: SetupConnect;
  /** The app ships a sample set. */
  sample?: boolean;
  starter_questions?: SetupStarterQuestion[];
  starter_routines?: SetupStarterRoutine[];
  starter_builds?: { dashboard?: SetupStarterBuild; workflow?: SetupStarterBuild };
}

/** The 5-field cron minutes, as the platform reads them (sprigr-team cron-parser). Throws on a bad field. */
function cronMinutes(expression: string): number[] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`expected 5 fields, got ${parts.length}`);
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const fields = parts.map((p, i) => parseField(p, ranges[i]![0], ranges[i]![1]));
  return fields[0]!;
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  const bound = (raw: string | undefined): number => {
    if (raw === undefined || !/^\d+$/.test(raw)) {
      throw new Error(`Invalid cron field value: ${raw ?? ''} in "${field}" (valid range: ${min}-${max})`);
    }
    const n = Number(raw);
    if (n < min || n > max) {
      throw new Error(`Invalid cron field value: ${n} (valid range: ${min}-${max})`);
    }
    return n;
  };

  for (const part of field.split(',')) {
    const pieces = part.split('/');
    if (pieces.length > 2) throw new Error(`Invalid step value: ${pieces.slice(1).join('/')}`);
    const [rangePart, stepStr] = pieces as [string, string | undefined];

    let step = 1;
    if (stepStr !== undefined) {
      step = /^\d+$/.test(stepStr) ? Number(stepStr) : NaN;
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step value: ${stepStr}`);
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2) throw new Error(`Invalid cron field value: ${rangePart} (valid range: ${min}-${max})`);
      start = bound(bounds[0]);
      end = bound(bounds[1]);
      if (start > end) throw new Error(`Invalid cron field value: ${rangePart} is a reversed range (valid range: ${min}-${max})`);
    } else {
      start = bound(rangePart);
      end = stepStr !== undefined ? max : start;
    }

    for (let i = start; i <= end; i += step) values.add(i);
  }

  return Array.from(values).sort((a, b) => a - b);
}

const F = 'setup';
const SLOTS: ReadonlySet<string> = new Set(SETUP_SLOTS);
const TEXT_MAX = 200;
const PROMPT_MAX = 2000;
const STARTERS_MAX = 3;
const INPUTS_MAX = 3;
const ROUTINE_NAME = /^[a-z][a-z0-9_]{1,31}$/;
const PAGE = /^\/[A-Za-z0-9._~\-/]*$/;
// Decision 0406: a connect input is never a secret; a key is typed on the app's own page.
// Matched per word of the name (site_url -> site, url), so "passenger" passes and "access_key" does not.
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'pass', 'passwd', 'password', 'passphrase', 'pwd', 'pin', 'secret', 'secrets', 'token', 'key', 'apikey',
  'auth', 'credential', 'credentials', 'otp',
]);
const SECRET_SUFFIX = /(token|secret|password|apikey)$/;

function looksSecret(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w) || SECRET_SUFFIX.test(w));
}

const BLOCK_KEYS = ['slots', 'built_in', 'connect', 'sample', 'starter_questions', 'starter_routines', 'starter_builds'];

interface SetupManifestLike {
  kind?: string;
  setup?: unknown;
  tools?: ReadonlyArray<{ name: string; input_schema?: Record<string, unknown> }>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownKey(o: Obj, allowed: readonly string[], path: string): string | null {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  return extra ? `${path} has unknown key "${extra}"; allowed: ${allowed.join(', ')}` : null;
}

function textProblem(v: unknown, path: string, max = TEXT_MAX): string | null {
  if (typeof v !== 'string' || v.trim().length === 0) return `${path} must be a non-empty string`;
  if (v.length > max) return `${path} is ${v.length} characters; max ${max}`;
  return null;
}

function slotProblem(v: unknown, path: string, declared: ReadonlySet<string>): string | null {
  if (typeof v !== 'string' || !declared.has(v)) {
    return `${path} must be one of the slots this app declares in ${F}.slots, got ${JSON.stringify(v)}`;
  }
  return null;
}

function slotsProblem(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return `${F}.slots must be a non-empty array of slots: ${SETUP_SLOTS.join(', ')}`;
  const seen = new Set<string>();
  for (const s of v) {
    if (typeof s !== 'string' || !SLOTS.has(s)) return `${F}.slots has unknown slot ${JSON.stringify(s)}; allowed: ${SETUP_SLOTS.join(', ')}`;
    if (seen.has(s)) return `${F}.slots lists "${s}" twice`;
    seen.add(s);
  }
  return null;
}

function connectProblem(v: unknown, builtIn: boolean, tools: SetupManifestLike['tools']): string | null {
  const path = `${F}.connect`;
  if (builtIn) return v === undefined ? null : `${path} must be absent when ${F}.built_in is true: a built-in app has no connect step`;
  if (!isObj(v)) return `${path} is required unless ${F}.built_in is true: { "tool": "<tool name>", "inputs"?: [...] } or { "page": "/<path>" }`;
  const hasTool = 'tool' in v;
  const hasPage = 'page' in v;
  if (hasTool === hasPage) return `${path} must declare exactly one of "tool" or "page"`;
  if (hasPage) {
    const uk = unknownKey(v, ['page'], path);
    if (uk) return uk;
    const page = v.page;
    if (typeof page !== 'string' || !PAGE.test(page) || page.startsWith('//') || page.includes('..') || page.length > TEXT_MAX) {
      return `${path}.page must be a path on the app's own page starting "/" (letters, digits, - . _ ~ /), got ${JSON.stringify(page)}`;
    }
    return null;
  }
  const uk = unknownKey(v, ['tool', 'inputs'], path);
  if (uk) return uk;
  const tool = (tools ?? []).find((t) => t.name === v.tool);
  if (!tool) return `${path}.tool ${JSON.stringify(v.tool)} is not a tool this manifest declares`;
  if (v.inputs === undefined) return null;
  if (!Array.isArray(v.inputs) || v.inputs.length === 0 || v.inputs.length > INPUTS_MAX) {
    return `${path}.inputs must be an array of 1 to ${INPUTS_MAX} inputs when present`;
  }
  const props = isObj(tool.input_schema?.properties) ? (tool.input_schema.properties as Obj) : {};
  const names = new Set<string>();
  for (let i = 0; i < v.inputs.length; i += 1) {
    const p = `${path}.inputs[${i}]`;
    const input = v.inputs[i];
    if (!isObj(input)) return `${p} must be an object { "name", "label", "placeholder"? }`;
    const ik = unknownKey(input, ['name', 'label', 'placeholder'], p);
    if (ik) return ik;
    const name = input.name;
    if (typeof name !== 'string' || !Object.hasOwn(props, name)) return `${p}.name ${JSON.stringify(name)} is not a property of ${String(v.tool)}'s input_schema`;
    if (looksSecret(name)) return `${p}.name "${name}" looks like a secret; a key or password is typed on the app's own page (use ${path}.page)`;
    if (names.has(name)) return `${p}.name "${name}" is declared twice`;
    names.add(name);
    const lErr = textProblem(input.label, `${p}.label`);
    if (lErr) return lErr;
    if (input.placeholder !== undefined) {
      const phErr = textProblem(input.placeholder, `${p}.placeholder`);
      if (phErr) return phErr;
    }
  }
  return null;
}

function startersProblem(v: unknown, path: string, keys: readonly string[], declared: ReadonlySet<string>, each: (o: Obj, p: string) => string | null): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > STARTERS_MAX) return `${path} must be an array of at most ${STARTERS_MAX}`;
  for (let i = 0; i < v.length; i += 1) {
    const p = `${path}[${i}]`;
    const o = v[i];
    if (!isObj(o)) return `${p} must be an object`;
    const uk = unknownKey(o, keys, p);
    if (uk) return uk;
    const sErr = slotProblem(o.slot, `${p}.slot`, declared);
    if (sErr) return sErr;
    const err = each(o, p);
    if (err) return err;
  }
  return null;
}

function routineProblem(seen: Set<string>) {
  return (o: Obj, p: string): string | null => {
    if (typeof o.name !== 'string' || !ROUTINE_NAME.test(o.name)) return `${p}.name must match ${ROUTINE_NAME.source}, got ${JSON.stringify(o.name)}`;
    if (seen.has(o.name)) return `${p}.name "${o.name}" is declared twice`;
    seen.add(o.name);
    for (const k of ['title', 'description'] as const) {
      const err = textProblem(o[k], `${p}.${k}`);
      if (err) return err;
    }
    const prErr = textProblem(o.prompt, `${p}.prompt`, PROMPT_MAX);
    if (prErr) return prErr;
    try {
      if (typeof o.cron !== 'string') throw new Error('not a string');
      // A starter routine runs at most hourly: one minute value.
      if (cronMinutes(o.cron).length !== 1) return `${p}.cron runs more than once an hour; a starter routine runs at most hourly, got ${JSON.stringify(o.cron)}`;
    } catch {
      return `${p}.cron must be a valid 5-field cron expression, got ${JSON.stringify(o.cron)}`;
    }
    return null;
  };
}

function buildsProblem(v: unknown, declared: ReadonlySet<string>): string | null {
  const path = `${F}.starter_builds`;
  if (v === undefined) return null;
  if (!isObj(v)) return `${path} must be an object { "dashboard"?, "workflow"? }`;
  const uk = unknownKey(v, ['dashboard', 'workflow'], path);
  if (uk) return uk;
  for (const k of ['dashboard', 'workflow'] as const) {
    if (v[k] === undefined) continue;
    const p = `${path}.${k}`;
    const b = v[k];
    if (!isObj(b)) return `${p} must be an object { "slot", "text" }`;
    const bk = unknownKey(b, ['slot', 'text'], p);
    if (bk) return bk;
    const err = slotProblem(b.slot, `${p}.slot`, declared) ?? textProblem(b.text, `${p}.text`);
    if (err) return err;
  }
  return null;
}

/** The first refusal for a manifest's `setup` block, or null. Absent passes. */
export function validateSetup(manifest: SetupManifestLike): string | null {
  const raw = manifest.setup;
  if (raw === undefined || raw === null) return null;
  if (manifest.kind === 'agent') return `${F} cannot be declared by an agent template (kind "agent"): it describes an app's connect step`;
  if (!isObj(raw)) return `${F} must be an object like { "slots": ["accounting"], "connect": { "tool": "..." } }`;
  const uk = unknownKey(raw, BLOCK_KEYS, F);
  if (uk) return uk;
  const slotsErr = slotsProblem(raw.slots);
  if (slotsErr) return slotsErr;
  for (const k of ['built_in', 'sample'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') return `${F}.${k} must be true or false`;
  }
  const connectErr = connectProblem(raw.connect, raw.built_in === true, manifest.tools);
  if (connectErr) return connectErr;
  const declared = new Set(raw.slots as string[]);
  const qErr = startersProblem(raw.starter_questions, `${F}.starter_questions`, ['slot', 'text'], declared, (o, p) => textProblem(o.text, `${p}.text`));
  if (qErr) return qErr;
  const rErr = startersProblem(raw.starter_routines, `${F}.starter_routines`, ['name', 'slot', 'title', 'description', 'cron', 'prompt'], declared, routineProblem(new Set()));
  if (rErr) return rErr;
  return buildsProblem(raw.starter_builds, declared);
}
