import { describe, expect, it } from 'vitest';
import { actorKey, parseActor } from '../src/actor';

describe('parseActor', () => {
  it('returns undefined when args lacks an actor (webhook / schedule path)', () => {
    expect(parseActor({ body: 'raw', headers: {} })).toBeUndefined();
  });

  it('returns undefined when args.actor is empty', () => {
    expect(parseActor({ actor: {} })).toBeUndefined();
  });

  it('returns undefined for non-object args', () => {
    expect(parseActor(null)).toBeUndefined();
    expect(parseActor('not-an-object')).toBeUndefined();
    expect(parseActor(undefined)).toBeUndefined();
  });

  it('returns all three fields when the wrapper stamped a bound-user agent', () => {
    const actor = parseActor({
      actor: { agentId: 'agent_field_joe', platformUserId: 'usr_platform_joe', role: 'staff' },
    });
    expect(actor).toEqual({
      agentId: 'agent_field_joe',
      platformUserId: 'usr_platform_joe',
      role: 'staff',
    });
  });

  it('drops missing fields silently for an unbound agent (no platformUserId)', () => {
    const actor = parseActor({ actor: { agentId: 'agent_orchestrator', role: 'system' } });
    expect(actor).toEqual({ agentId: 'agent_orchestrator', role: 'system' });
    expect(actor!.platformUserId).toBeUndefined();
  });

  it('rejects junk values (non-strings, empty strings)', () => {
    const actor = parseActor({
      actor: { agentId: '', platformUserId: 123 as unknown as string, role: null as unknown as string },
    });
    expect(actor).toBeUndefined();
  });

  it('passes through partial agent-only (no role, no platformUserId)', () => {
    expect(parseActor({ actor: { agentId: 'a' } })).toEqual({ agentId: 'a' });
  });
});

describe('actorKey', () => {
  it('returns null for undefined', () => {
    expect(actorKey(undefined)).toBeNull();
  });

  it('prefers platformUserId over agentId (durable across agent rebinds)', () => {
    expect(actorKey({ agentId: 'agent_a', platformUserId: 'usr_p' })).toBe('u:usr_p');
  });

  it('falls back to agentId when there is no bound user', () => {
    expect(actorKey({ agentId: 'agent_orchestrator' })).toBe('a:agent_orchestrator');
  });

  it('returns null when neither id is set', () => {
    expect(actorKey({ role: 'staff' })).toBeNull();
  });
});
