import { describe, expect, it } from 'vitest';
import {
  createSampleStore,
  createSimulator,
  NotSimulatedError,
  plainDialect,
  SAMPLE_FLAG_ID,
  SAMPLE_FLAG_RESOURCE,
  type PlainRoute,
  type SampleObject,
  type SampleSeed,
} from '../src/index';
import { makeMockD1 } from './mock-d1';

const TABLE = 'sample_objects';
const BASE = 'https://vendor.example/api';
const OVERLAY_READ = /^SELECT id, body, deleted FROM sample_objects WHERE resource = \?$/;
const WRITE = /^INSERT INTO sample_objects /;

/**
 * Every invoice carries a number, lines, a total and a null reference; only one
 * has a status. Payments carry their invoice and amount. Notes all carry a null
 * flag; only one is pinned.
 */
const SEED: SampleSeed = {
  invoices: {
    idField: 'InvoiceID',
    items: [
      { InvoiceID: 'v1', Number: 'N-1', Customer: 'Acme', Lines: [{ Qty: 2, Price: 5 }], Total: 10, Reference: null },
      { InvoiceID: 'v2', Number: 'N-2', Customer: 'Birch', Lines: [{ Qty: 1, Price: 7 }], Total: 7, Reference: null, Status: 'PAID' },
    ],
  },
  payments: { idField: 'PaymentID', items: [{ PaymentID: 'p1', InvoiceID: 'v2', Amount: 7 }] },
  notes: {
    idField: 'NoteID',
    items: [
      { NoteID: 'n1', Text: 'a', Flag: null },
      { NoteID: 'n2', Text: 'b', Flag: null, Pinned: true },
    ],
  },
  projects: { idField: 'ProjectID', items: [{ ProjectID: 'pr1' }, { ProjectID: 'pr2' }] },
  tasks: {
    idField: 'TaskID',
    items: [
      { TaskID: 't1', ProjectID: 'pr1', Name: 'Measure' },
      { TaskID: 't2', ProjectID: 'pr2', Name: 'Strip' },
    ],
  },
};

type Line = { Qty: number; Price: number };
const lineTotal = (lines: unknown): number => (lines as Line[]).reduce((sum, l) => sum + l.Qty * l.Price, 0);
const paid = (payments: SampleObject[], invoiceId: unknown): number =>
  payments.filter((p) => p.InvoiceID === invoiceId).reduce((sum, p) => sum + Number(p.Amount), 0);

type Rules = Record<string, unknown>;

/** The invoice rules an app would supply: a next number and a total on write, the amount due on read. */
const invoiceRules = (): Rules => ({
  computed: ['AmountDue'],
  complete: (obj: SampleObject, ctx: { op: string; objects: SampleObject[] }) => ({
    ...obj,
    Number: obj.Number ?? `N-${ctx.objects.length + 1}`,
    Total: lineTotal(obj.Lines),
    Reference: obj.Reference ?? null,
  }),
  uses: ['payments'],
  derive: (obj: SampleObject, related: Record<string, SampleObject[]>) => ({
    ...obj,
    AmountDue: Number(obj.Total) - paid(related.payments ?? [], obj.InvoiceID),
  }),
});

const parent = { param: 'projectId', resource: 'projects', field: 'ProjectID' };

const ROUTES: PlainRoute[] = [
  { method: 'GET', path: '/invoices', op: 'list', resource: 'invoices', wrap: 'Invoices' },
  { method: 'GET', path: '/invoices/:id', op: 'get', resource: 'invoices', wrap: 'Invoices' },
  { method: 'PUT', path: '/invoices', op: 'create', resource: 'invoices', wrap: 'Invoices', bodyKey: 'Invoices' },
  { method: 'POST', path: '/invoices', op: 'create', resource: 'invoices', wrap: 'Invoices', bodyKey: 'Invoices', upsert: true },
  { method: 'POST', path: '/invoices/:id', op: 'update', resource: 'invoices', wrap: 'Invoices', bodyKey: 'Invoices' },
  { method: 'GET', path: '/payments', op: 'list', resource: 'payments', wrap: 'Payments' },
  { method: 'PUT', path: '/payments', op: 'create', resource: 'payments', wrap: 'Payments', bodyKey: 'Payments' },
  { method: 'GET', path: '/notes', op: 'list', resource: 'notes' },
  { method: 'PUT', path: '/notes', op: 'create', resource: 'notes' },
  { method: 'POST', path: '/notes/:id', op: 'update', resource: 'notes' },
  { method: 'POST', path: '/projects/:projectId/tasks', op: 'create', resource: 'tasks', parent, upsert: true },
  { method: 'GET', path: '/projects/:projectId/tasks', op: 'list', resource: 'tasks', parent },
  { method: 'GET', path: '/projects/:projectId/tasks/:id', op: 'get', resource: 'tasks', parent },
  { method: 'POST', path: '/projects/:projectId/tasks/:id', op: 'update', resource: 'tasks', parent },
];

/** Built per test, so a throwing build fails each row by name. */
function install(resources: Record<string, Rules> = { invoices: invoiceRules() }, seed: SampleSeed = SEED) {
  const d1 = makeMockD1(TABLE, [{ resource: SAMPLE_FLAG_RESOURCE, id: SAMPLE_FLAG_ID, body: '{}', deleted: 0 }]);
  const store = createSampleStore({ db: d1.db, table: TABLE });
  const dialect = plainDialect({ base: '/api', routes: ROUTES, resources });
  const sim = createSimulator({ seed, dialect, store });
  return { d1, sim };
}

const count = (statements: string[], re: RegExp) => statements.filter((s) => re.test(s)).length;
const send = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function wrapped(res: Response, key: string): Promise<SampleObject[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Record<string, SampleObject[]>)[key] ?? [];
}

/** The refusal a request ends in, or null when it was answered. */
async function refusal(p: Promise<Response>): Promise<NotSimulatedError | null> {
  return p.then(
    () => null,
    (e: unknown) => {
      if (e instanceof NotSimulatedError) return e;
      throw e;
    },
  );
}

const newInvoice = (customer: string, lines: Line[]) => ({ Customer: customer, Lines: lines });

describe('the seed check: every answered object carries what every seed object carries', () => {
  it('a create with no completion function whose body lacks a seed field is refused, and nothing is written', async () => {
    const { d1, sim } = install();
    const err = await refusal(sim.fetch(`${BASE}/payments`, send('PUT', { Payments: [{ Amount: 4 }] })));
    expect(err?.reason).toBe('computed');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a create whose body already carries every seed field is answered with the body plus an id', async () => {
    const { sim } = install();
    const [created] = await wrapped(await sim.fetch(`${BASE}/payments`, send('PUT', { Payments: [{ InvoiceID: 'v1', Amount: 4 }] })), 'Payments');
    expect(created).toMatchObject({ InvoiceID: 'v1', Amount: 4 });
    expect(typeof created?.PaymentID).toBe('string');
  });

  it('a field that is null on every seed object is required as a key, and null satisfies it', async () => {
    const { d1, sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/notes`, send('PUT', { Text: 'c' }))))?.reason).toBe('computed');
    expect(count(d1.statements, WRITE)).toBe(0);
    const created = (await (await sim.fetch(`${BASE}/notes`, send('PUT', { Text: 'c', Flag: null }))).json()) as SampleObject;
    expect(created).toMatchObject({ Text: 'c', Flag: null });
  });

  it('a field only some seed objects carry is not required', async () => {
    const { sim } = install();
    const res = await sim.fetch(`${BASE}/notes`, send('PUT', { Text: 'c', Flag: null }));
    expect(res.status).toBe(200);
    expect((await res.json()) as SampleObject).not.toHaveProperty('Pinned');
  });

  it('the overlay never widens the shape: a field written onto every object is still not required', async () => {
    const { sim } = install();
    for (const id of ['n1', 'n2']) await sim.fetch(`${BASE}/notes/${id}`, send('POST', { Colour: 'red' }));
    expect((await sim.fetch(`${BASE}/notes`, send('PUT', { Text: 'c', Flag: null }))).status).toBe(200);
  });

  it('a derive that leaves a declared computed field out is refused on a get, and a list holding that object is refused whole', async () => {
    const rules = { ...invoiceRules(), derive: (obj: SampleObject) => (obj.InvoiceID === 'v2' ? obj : { ...obj, AmountDue: 0 }) };
    const { sim } = install({ invoices: rules });
    expect((await sim.fetch(`${BASE}/invoices/v1`)).status).toBe(200);
    expect((await refusal(sim.fetch(`${BASE}/invoices/v2`)))?.reason).toBe('computed');
    expect((await refusal(sim.fetch(`${BASE}/invoices`)))?.reason).toBe('computed');
  });

  it('a seed object lacking a declared computed field that only complete fills is refused on a get when a derive is declared', async () => {
    const rules = { ...invoiceRules(), computed: ['AmountDue', 'Code'], complete: (obj: SampleObject) => ({ ...obj, Code: 'C', Total: lineTotal(obj.Lines) }) };
    const { sim } = install({ invoices: rules });
    expect((await refusal(sim.fetch(`${BASE}/invoices/v1`)))?.reason).toBe('computed');
  });
});

describe('the build refuses what can never be answered', () => {
  it('a resource the dialect writes, with no seed objects and no computed declaration, throws at build', () => {
    const seed: SampleSeed = { ...SEED, notes: { idField: 'NoteID', items: [] } };
    expect(() => install({ invoices: invoiceRules() }, seed)).toThrow(TypeError);
    expect(() => install({ invoices: invoiceRules(), notes: { computed: [] } }, seed)).not.toThrow();
  });

  it('a declared computed field that a seed object lacks, with no derive to fill it on a read, throws at build', () => {
    const complete = (obj: SampleObject) => ({ ...obj, Code: 'C' });
    expect(() => install({ invoices: invoiceRules(), notes: { computed: ['Code'], complete } })).toThrow(TypeError);
    const seed: SampleSeed = { ...SEED, notes: { idField: 'NoteID', items: SEED.notes!.items.map((n) => ({ ...n, Code: 'C' })) } };
    expect(() => install({ invoices: invoiceRules(), notes: { computed: ['Code'], complete } }, seed)).not.toThrow();
  });

  it('computed with neither complete nor derive, and uses without derive, each throw at build', () => {
    const build = (rules: Rules) => () => plainDialect({ routes: ROUTES, resources: { invoices: rules } });
    expect(build({ computed: ['AmountDue'] })).toThrow(TypeError);
    expect(build({ computed: [], complete: (o: SampleObject) => o, uses: ['payments'] })).toThrow(TypeError);
  });
});

describe('completion: the app fills what the vendor computes', () => {
  it('a create stores and answers the computed fields, and a later get answers the same', async () => {
    const { sim } = install();
    const [created] = await wrapped(await sim.fetch(`${BASE}/invoices`, send('PUT', { Invoices: [newInvoice('Cedar', [{ Qty: 3, Price: 4 }])] })), 'Invoices');
    expect(created).toMatchObject({ Customer: 'Cedar', Number: 'N-3', Total: 12, Reference: null, AmountDue: 12 });
    const [got] = await wrapped(await sim.fetch(`${BASE}/invoices/${String(created?.InvoiceID)}`), 'Invoices');
    expect(got).toEqual(created);
  });

  it('a batch numbers each object counting the earlier objects of the same batch', async () => {
    const { sim } = install();
    const created = await wrapped(
      await sim.fetch(`${BASE}/invoices`, send('PUT', { Invoices: [newInvoice('Cedar', [{ Qty: 1, Price: 1 }]), newInvoice('Dune', [{ Qty: 1, Price: 2 }])] })),
      'Invoices',
    );
    expect(created.map((c) => c.Number)).toEqual(['N-3', 'N-4']);
  });

  it('an update recomputes from the merged object and keeps what it does not change', async () => {
    const { sim } = install();
    const [updated] = await wrapped(await sim.fetch(`${BASE}/invoices/v1`, send('POST', { Invoices: [{ Lines: [{ Qty: 5, Price: 5 }] }] })), 'Invoices');
    expect(updated).toMatchObject({ InvoiceID: 'v1', Number: 'N-1', Customer: 'Acme', Total: 25, AmountDue: 25 });
  });

  it('complete leaving out a field every seed object carries refuses the whole batch, and nothing is written', async () => {
    const rules = { complete: (obj: SampleObject) => ({ ...obj, Number: 'N-9', Reference: null }) };
    const { d1, sim } = install({ invoices: rules });
    const body = { Invoices: [newInvoice('Cedar', [{ Qty: 1, Price: 1 }]), newInvoice('Dune', [{ Qty: 1, Price: 2 }])] };
    expect((await refusal(sim.fetch(`${BASE}/invoices`, send('PUT', body))))?.reason).toBe('computed');
    expect(count(d1.statements, WRITE)).toBe(0);
  });

  it('a throw from complete, or from derive, is refused as computed with the throw kept as its cause', async () => {
    const boom = new Error('cannot number this');
    const throwing = { ...invoiceRules(), complete: () => { throw boom; } };
    const a = install({ invoices: throwing });
    const err = await refusal(a.sim.fetch(`${BASE}/invoices`, send('PUT', { Invoices: [newInvoice('Cedar', [{ Qty: 1, Price: 1 }])] })));
    expect(err?.reason).toBe('computed');
    expect(err?.cause).toBe(boom);
    expect(count(a.d1.statements, WRITE)).toBe(0);

    const b = install({ invoices: { ...invoiceRules(), derive: () => { throw boom; } } });
    const readErr = await refusal(b.sim.fetch(`${BASE}/invoices/v1`));
    expect(readErr?.reason).toBe('computed');
    expect(readErr?.cause).toBe(boom);
  });

  it('a write to a used resource changes the derived field on the next read, at one added overlay read', async () => {
    const { d1, sim } = install();
    await sim.fetch(`${BASE}/payments`, send('PUT', { Payments: [{ InvoiceID: 'v1', Amount: 4 }] }));
    const before = d1.statements.length;
    const [got] = await wrapped(await sim.fetch(`${BASE}/invoices/v1`), 'Invoices');
    expect(got?.AmountDue).toBe(6);
    expect(count(d1.statements.slice(before), OVERLAY_READ)).toBe(2);
  });
});

describe('a create carrying an id that already exists', () => {
  it('is refused as exists, alone and as the second object of a batch, and nothing is written', async () => {
    const { d1, sim } = install();
    const taken = { InvoiceID: 'v1', ...newInvoice('Taken', [{ Qty: 1, Price: 1 }]) };
    for (const Invoices of [[taken], [newInvoice('Cedar', [{ Qty: 1, Price: 1 }]), taken]]) {
      expect((await refusal(sim.fetch(`${BASE}/invoices`, send('PUT', { Invoices }))))?.reason).toBe('exists');
    }
    expect(count(d1.statements, WRITE)).toBe(0);
    const [v1] = await wrapped(await sim.fetch(`${BASE}/invoices/v1`), 'Invoices');
    expect(v1?.Customer).toBe('Acme');
  });

  it('on an upsert route, merges into the stored object as an update, and creates the one without an id', async () => {
    const { sim } = install();
    const answered = await wrapped(
      await sim.fetch(`${BASE}/invoices`, send('POST', { Invoices: [{ InvoiceID: 'v1', Status: 'VOIDED' }, newInvoice('Cedar', [{ Qty: 1, Price: 1 }])] })),
      'Invoices',
    );
    expect(answered[0]).toMatchObject({ InvoiceID: 'v1', Status: 'VOIDED', Customer: 'Acme', Number: 'N-1', Total: 10 });
    expect(answered[1]).toMatchObject({ Customer: 'Cedar', Number: 'N-3' });
    const [v1] = await wrapped(await sim.fetch(`${BASE}/invoices/v1`), 'Invoices');
    expect(v1).toMatchObject({ Status: 'VOIDED', Customer: 'Acme' });
  });

  it("on an upsert route under a parent, another parent's child is still refused as parent", async () => {
    const { d1, sim } = install();
    expect((await refusal(sim.fetch(`${BASE}/projects/pr1/tasks`, send('POST', { TaskID: 't2', Name: 'Taken' }))))?.reason).toBe('parent');
    expect(count(d1.statements, WRITE)).toBe(0);
  });
});

describe('the new reasons keep the message', () => {
  it('computed and exists carry the same message text as any other refusal', () => {
    const base = new NotSimulatedError('PUT', '/api/invoices').message;
    for (const reason of ['computed', 'exists'] as const) {
      const err = new NotSimulatedError('PUT', '/api/invoices', reason);
      expect(err.message).toBe(base);
      expect(err.reason).toBe(reason);
    }
  });
});

describe('a rule names only what the seed has', () => {
  it('a resources key that is not a seed resource throws at build', () => {
    expect(() => install({ invoices: invoiceRules(), invoice: { computed: [], complete: (o: SampleObject) => o } })).toThrow(TypeError);
  });

  it('a uses entry that is not a seed resource throws at build', () => {
    expect(() => install({ invoices: { ...invoiceRules(), uses: ['payment'] } })).toThrow(TypeError);
  });
});

describe('the app cannot move an object or change its id', () => {
  const taskIds = async (res: Response) => ((await res.json()) as SampleObject[]).map((t) => t.TaskID);

  it('a create keeps the parent from the path, whatever complete does with the parent field', async () => {
    const moves = (obj: SampleObject) => ({ ...obj, ProjectID: 'pr2' });
    const drops = (obj: SampleObject) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'ProjectID'));
    for (const complete of [moves, drops]) {
      const { sim } = install({ invoices: invoiceRules(), tasks: { complete } });
      const created = (await (await sim.fetch(`${BASE}/projects/pr1/tasks`, send('POST', { Name: 'Fit' }))).json()) as SampleObject;
      expect(created.ProjectID).toBe('pr1');
      expect(await taskIds(await sim.fetch(`${BASE}/projects/pr1/tasks`))).toContain(created.TaskID);
      expect(await taskIds(await sim.fetch(`${BASE}/projects/pr2/tasks`))).not.toContain(created.TaskID);
    }
  });

  it('an update keeps the parent, whatever complete does with the parent field', async () => {
    const { sim } = install({ invoices: invoiceRules(), tasks: { complete: (obj: SampleObject) => ({ ...obj, ProjectID: 'pr2' }) } });
    const updated = (await (await sim.fetch(`${BASE}/projects/pr1/tasks/t1`, send('POST', { Name: 'Remeasure' }))).json()) as SampleObject;
    expect(updated).toMatchObject({ TaskID: 't1', ProjectID: 'pr1', Name: 'Remeasure' });
    expect(await taskIds(await sim.fetch(`${BASE}/projects/pr1/tasks`))).toContain('t1');
    expect(await taskIds(await sim.fetch(`${BASE}/projects/pr2/tasks`))).not.toContain('t1');
  });

  it('an answer carries the stored id and parent, whatever derive returns for them', async () => {
    const derive = (obj: SampleObject) => ({ ...obj, TaskID: 'other', ProjectID: 'pr2' });
    const { sim } = install({ invoices: invoiceRules(), tasks: { uses: [], derive } });
    const got = (await (await sim.fetch(`${BASE}/projects/pr1/tasks/t1`)).json()) as SampleObject;
    expect(got).toMatchObject({ TaskID: 't1', ProjectID: 'pr1' });
    expect(await taskIds(await sim.fetch(`${BASE}/projects/pr1/tasks`))).toEqual(['t1']);
  });
});
