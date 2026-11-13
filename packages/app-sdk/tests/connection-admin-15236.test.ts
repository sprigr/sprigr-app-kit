/**
 * sprigr-team#15236: an owner or admin may change an install-wide connection
 * through any agent they chat with, on their own role; nobody else may.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseActor } from '../src/actor';
import { gateConnectionAdminTools, refuseUnlessConnectionAdminActor } from '../src/connection-admin';

const HINT = 'Ask an owner or admin.';
const gate = (actor: Record<string, unknown> | undefined) =>
  refuseUnlessConnectionAdminActor(actor === undefined ? {} : { actor }, { hint: HINT });
const REFUSED = { ok: false, error: 'connection_admin_required', hint: HINT };

describe('parseActor keeps driverRole only for the live person', () => {
  it('beside a live person', () => {
    expect(parseActor({ actor: { platformUserId: 'usr_b', personId: 'usr_o', personSource: 'live', driverRole: 'owner' } })?.driverRole).toBe('owner');
  });
  it('never with a stamped person or with no person', () => {
    expect(parseActor({ actor: { personId: 'usr_o', personSource: 'schedule_creator', driverRole: 'owner' } })?.driverRole).toBeUndefined();
    expect(parseActor({ actor: { platformUserId: 'usr_b', driverRole: 'owner' } })?.driverRole).toBeUndefined();
  });
});

describe('refuseUnlessConnectionAdminActor', () => {
  it('lets an owner through a specialist agent that has no bound user', () => {
    expect(gate({ agentId: 'agt_s', personId: 'usr_o', personSource: 'live', driverRole: 'owner' })).toBeNull();
  });

  it('lets an admin through a shared agent bound to a member', () => {
    expect(gate({ platformUserId: 'usr_m', role: 'member', personId: 'usr_a', personSource: 'live', driverRole: 'admin' })).toBeNull();
  });

  it("refuses a member driving an owner-bound agent, on the member's own role", () => {
    expect(gate({ platformUserId: 'usr_o', role: 'owner', personId: 'usr_m', personSource: 'live', driverRole: 'member' })).toEqual(REFUSED);
  });

  it('runs a system turn no person drove as an owner or admin bound user, and refuses otherwise', () => {
    expect(gate({ platformUserId: 'usr_o', role: 'owner', surface: 'system' })).toBeNull();
    expect(gate({ platformUserId: 'usr_a', role: 'admin', surface: 'system' })).toBeNull();
    expect(gate({ platformUserId: 'usr_m', role: 'member', surface: 'system' })).toEqual(REFUSED);
    expect(gate({ agentId: 'agt_s', role: 'owner', surface: 'system' })).toEqual(REFUSED);
  });

  // A website or channel turn can create a schedule with no recorded creator; its run must not borrow the bound role.
  it('refuses a schedule run with no person on an owner-bound agent', () => {
    expect(gate({ platformUserId: 'usr_o', role: 'owner', surface: 'schedule' })).toEqual(REFUSED);
  });

  // These callers carry no person either: an owner-bound agent must not lend them its role.
  it('refuses a website visitor, a channel sender, an MCP client, a webhook, a workflow, another agent and a missing surface', () => {
    for (const surface of ['website', 'external_channel', 'mcp', 'webhook', 'workflow', 'delegated', 'portal', undefined]) {
      expect(gate({ platformUserId: 'usr_o', role: 'owner', ...(surface ? { surface } : {}) })).toEqual(REFUSED);
    }
  });

  it('refuses every person source but live, whatever the roles say', () => {
    for (const personSource of ['schedule_creator', 'workflow_saver', 'workflow_starter', 'delegation_originator']) {
      expect(gate({ platformUserId: 'usr_o', role: 'owner', personId: 'usr_o', personSource })).toEqual(REFUSED);
    }
  });

  it('refuses with no actor at all', () => {
    expect(gate(undefined)).toEqual(REFUSED);
  });

  // Compatibility until every gated app runs on a platform that stamps driverRole.
  it('with no driverRole, passes only the bound user on an owner or admin bound role', () => {
    expect(gate({ platformUserId: 'usr_o', role: 'owner', personId: 'usr_o', personSource: 'live' })).toBeNull();
    expect(gate({ platformUserId: 'usr_o', role: 'owner', personId: 'usr_m', personSource: 'live' })).toEqual(REFUSED);
    expect(gate({ platformUserId: 'usr_m', role: 'member', personId: 'usr_m', personSource: 'live' })).toEqual(REFUSED);
  });
});

describe('gateConnectionAdminTools', () => {
  it('refuses before the handler runs, and runs it for an admin', async () => {
    const connect = vi.fn(async () => ({ ok: true }));
    const gated = gateConnectionAdminTools({ connect, list: vi.fn() }, ['connect'], { hint: HINT });
    expect(Object.keys(gated)).toEqual(['connect']);
    expect(await gated.connect!({ actor: { personId: 'usr_m', personSource: 'live', driverRole: 'member' } })).toEqual(REFUSED);
    expect(connect).not.toHaveBeenCalled();
    expect(await gated.connect!({ actor: { personId: 'usr_a', personSource: 'live', driverRole: 'admin' } }, 'env')).toEqual({ ok: true });
    expect(connect).toHaveBeenCalledWith({ actor: { personId: 'usr_a', personSource: 'live', driverRole: 'admin' } }, 'env');
  });

  it('throws on a name that is not in the registry, so a rename cannot drop the gate', () => {
    expect(() => gateConnectionAdminTools({}, ['connect'], { hint: HINT })).toThrow(/connect is not in the registry/);
  });
});
