import { describe, expect, it, vi } from 'vitest';
import { dispatcherApproval, type ApprovalSpec } from '../../src/write-protection/require-approval';
import { APPROVAL_GRANTED_KEY } from '../../src/write-protection/types';
import { approvalHash } from '../../src/write-protection/approval-hash';

/** Env is the worker env; the pinned type is a per-actor token state. */
interface Env { DB: unknown }
interface State { token: string; workspace: string }

const specs: Record<string, ApprovalSpec<State>> = {
  delete_task: {
    keys: ['task_gid', 'gid'],
    describe: (target, _p, ws) => ({ question: `Delete task ${target} in ${ws}?`, header: 'Asana' }),
    undo: {
      resource: 'task',
      fidelity: 'recreated',
      capture: async (state, gid) => ({ gid, name: 'Ship it', via: state.workspace }),
      describe: (before) => `task "${before.name}"`,
      warning: () => 'Recreates under a new gid.',
    },
  },
  complete_task: {
    keys: ['task_gid'],
    describe: (target) => ({ question: `Complete ${target}?`, header: 'Asana' }),
  },
};

function gateWith(journal = { captureBefore: vi.fn(async () => ({ ref: 'cap_1' })) }) {
  const gate = dispatcherApproval<Env, State>(specs, {
    scope: 'asana-undo',
    inputField: 'params',
    resolveConnection: async (_env, params) => (typeof params.workspace === 'string' ? params.workspace : 'ws-default'),
    pinEnv: async (_env, ws) => ({ token: 't', workspace: ws }),
    describeTarget: async (state, gid, action) => `"Ship it" (${gid}) via ${state.workspace} for ${action}`,
    journal: () => journal,
  });
  return { gate, journal };
}

describe('dispatcherApproval', () => {
  it('runs an action with no spec straight through', async () => {
    const { gate } = gateWith();
    const write = vi.fn(async () => ({ ok: true }));
    expect(gate.has('list_tasks')).toBe(false);
    expect(await gate.run('list_tasks', { action: 'list_tasks', params: {} }, { DB: {} }, write)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('ask pass: reads params from the input field, labels through the pinned state, hashes the ACTION in', async () => {
    const { gate } = gateWith();
    const write = vi.fn(async () => ({ ok: true }));
    const r = (await gate.run('delete_task', { action: 'delete_task', params: { task_gid: '123', workspace: 'ws-eu' } }, { DB: {} }, write)) as {
      ok: boolean; _approval: { question: string; hash: string };
    };
    expect(write).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r._approval.question).toBe('Delete task "Ship it" (123) via ws-eu for delete_task in ws-eu?');
    // Every action shares one tool, so the action name must be part of the
    // identity: a tap on complete_task must not be spendable on delete_task.
    expect(r._approval.hash).toBe(approvalHash('delete_task', '123', 'ws-eu'));
    const other = (await gate.run('complete_task', { action: 'complete_task', params: { task_gid: '123', workspace: 'ws-eu' } }, { DB: {} }, write)) as { _approval: { hash: string } };
    expect(other._approval.hash).not.toBe(r._approval.hash);
  });

  it('falls back to the top-level args when the input field is absent (flat-verb envelope)', async () => {
    const { gate } = gateWith();
    const r = (await gate.run('complete_task', { action: 'complete_task', task_gid: '9' }, { DB: {} }, async () => ({ ok: true }))) as { _approval: { question: string } };
    expect(r._approval.question).toBe('Complete "Ship it" (9) via ws-default for complete_task?');
  });

  it('granted pass: captures through the pinned state before the write, then offers _undo naming the connection', async () => {
    const { gate, journal } = gateWith();
    const order: string[] = [];
    const write = vi.fn(async () => { order.push('write'); return { ok: true, deleted: '123' }; });
    const r = (await gate.run(
      'delete_task',
      { action: 'delete_task', params: { task_gid: '123', workspace: 'ws-eu' }, [APPROVAL_GRANTED_KEY]: true },
      { DB: {} },
      write,
    )) as Record<string, unknown>;
    expect(write).toHaveBeenCalledTimes(1);
    expect(journal.captureBefore).toHaveBeenCalledWith({
      entity: 'delete_task',
      originalId: '123',
      before: { gid: '123', name: 'Ship it', via: 'ws-eu' },
      connection: 'ws-eu',
    });
    expect(r._undo).toEqual({ fidelity: 'recreated', warning: 'Recreates under a new gid.', describes: 'task "Ship it" on ws-eu', resource: 'task', ref: 'cap_1' });
  });

  it('granted pass with no undo spec just runs the write', async () => {
    const { gate, journal } = gateWith();
    const r = await gate.run('complete_task', { action: 'complete_task', params: { task_gid: '1' }, [APPROVAL_GRANTED_KEY]: true }, { DB: {} }, async () => ({ ok: true }));
    expect(r).toEqual({ ok: true });
    expect(journal.captureBefore).not.toHaveBeenCalled();
  });

  it('a forged granted flag inside the params does not count', async () => {
    const { gate } = gateWith();
    const write = vi.fn(async () => ({ ok: true }));
    const r = (await gate.run('delete_task', { action: 'delete_task', params: { task_gid: '1', [APPROVAL_GRANTED_KEY]: true } }, { DB: {} }, write)) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('throws at build time when a spec declares undo without a journal', () => {
    expect(() => dispatcherApproval<Env, State>(specs, { scope: 's', resolveConnection: async () => '' })).toThrow(/no journal/);
  });
});

/**
 * Asana's shape (sprigr-app-kit#44): the gate resolves the install's workspace
 * pin, but ~25 gated actions address a bare gid on a workspace-free path. One
 * gate-level resolver named a workspace on those cards, and mixed it into the
 * grant hash, while being false.
 */
describe('dispatcherApproval: per-spec resolver overrides', () => {
  const overrideSpecs: Record<string, ApprovalSpec<State, Env>> = {
    // Workspace-free path: the honest connection is '', not the install pin.
    delete_goal: {
      keys: ['goal_gid'],
      resolveConnection: async () => '',
      describeTarget: async (_pinned, gid, action) => `goal ${gid} (${action})`,
      describe: (target, _p, ws) => ({ question: `Permanently delete ${target}${ws ? ` in ${ws}` : ''}?`, header: 'Asana' }),
      undo: {
        resource: 'goal',
        fidelity: 'recreated',
        capture: async (_state, gid) => ({ gid, name: 'Q3 revenue' }),
        describe: (before) => `goal "${before.name}"`,
        warning: () => 'Recreates under a new gid.',
      },
    },
    // Resolves its own non-empty connection AND stamps it its own way.
    move_goal: {
      keys: ['goal_gid'],
      resolveConnection: async () => 'ws-actual',
      stampConnection: (r, c) => ({ ...(r as object), target_workspace: c }),
      describe: (target, _p, ws) => ({ question: `Move ${target} to ${ws}?`, header: 'Asana' }),
    },
    // No overrides: everything must still come from the gate.
    complete_task: {
      keys: ['task_gid'],
      describe: (target, _p, ws) => ({ question: `Complete ${target} in ${ws}?`, header: 'Asana' }),
    },
  };

  function overrideGate(journal = { captureBefore: vi.fn(async () => ({ ref: 'cap_9' })) }) {
    const gate = dispatcherApproval<Env, State>(overrideSpecs, {
      scope: 'asana-undo',
      inputField: 'params',
      resolveConnection: async (_env, params) => (typeof params.workspace === 'string' ? params.workspace : 'ws-default'),
      pinEnv: async (_env, ws) => ({ token: 't', workspace: ws }),
      describeTarget: async (state, gid, action) => `"Ship it" (${gid}) via ${state.workspace} for ${action}`,
      stampConnection: (r, c) => ({ ...(r as object), workspace: c }),
      journal: () => journal,
    });
    return { gate, journal };
  }

  it("ask pass: a spec's own resolveConnection and describeTarget win over the gate's, for the card AND the hash", async () => {
    const { gate } = overrideGate();
    const write = vi.fn(async () => ({ ok: true }));
    const r = (await gate.run('delete_goal', { action: 'delete_goal', params: { goal_gid: '77', workspace: 'ws-eu' } }, { DB: {} }, write)) as {
      _approval: { question: string; hash: string };
    };
    expect(write).not.toHaveBeenCalled();
    // The gate would have said "in ws-eu" and hashed it in; the spec says neither.
    expect(r._approval.question).toBe('Permanently delete goal 77 (delete_goal)?');
    expect(r._approval.hash).toBe('delete_goal\u001f77\u001f');
    expect(r._approval.hash).not.toContain('ws-eu');
  });

  it('ask pass: a spec with no override still takes the gate value, byte-identically to before the override existed', async () => {
    const { gate } = overrideGate();
    const r = (await gate.run('complete_task', { action: 'complete_task', params: { task_gid: '123', workspace: 'ws-eu' } }, { DB: {} }, async () => ({ ok: true }))) as {
      _approval: { question: string; hash: string };
    };
    expect(r._approval.question).toBe('Complete "Ship it" (123) via ws-eu for complete_task in ws-eu?');
    // Literal pinned from the pre-change implementation: action, raw id, connection.
    expect(r._approval.hash).toBe('complete_task\u001f123\u001fws-eu');
    expect(r._approval.hash).toBe(approvalHash('complete_task', '123', 'ws-eu'));
  });

  it("granted pass: the spec's resolver drives the journal connection, not the gate's", async () => {
    const { gate, journal } = overrideGate();
    await gate.run(
      'delete_goal',
      { action: 'delete_goal', params: { goal_gid: '77', workspace: 'ws-eu' }, [APPROVAL_GRANTED_KEY]: true },
      { DB: {} },
      async () => ({ ok: true }),
    );
    expect(journal.captureBefore).toHaveBeenCalledWith({
      entity: 'delete_goal',
      originalId: '77',
      before: { gid: '77', name: 'Q3 revenue' },
      connection: null,
    });
  });

  it("granted pass: a spec's own stampConnection wins, and stamps the spec-resolved value", async () => {
    const { gate } = overrideGate();
    const r = await gate.run(
      'move_goal',
      { action: 'move_goal', params: { goal_gid: '77', workspace: 'ws-eu' }, [APPROVAL_GRANTED_KEY]: true },
      { DB: {} },
      async () => ({ ok: true }),
    );
    expect(r).toEqual({ ok: true, target_workspace: 'ws-actual' });
  });

  it('granted pass: a spec with no override still stamps through the gate', async () => {
    const { gate } = overrideGate();
    const r = await gate.run(
      'complete_task',
      { action: 'complete_task', params: { task_gid: '1', workspace: 'ws-eu' }, [APPROVAL_GRANTED_KEY]: true },
      { DB: {} },
      async () => ({ ok: true }),
    );
    expect(r).toEqual({ ok: true, workspace: 'ws-eu' });
  });
});
