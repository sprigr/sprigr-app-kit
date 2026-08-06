/**
 * The "connect as" helpers.
 *
 * The bug these exist to remove: a settings page could only offer the
 * viewer as the owner of an OAuth connection, so every Connect button bound
 * the token to a person. That works in their chats and fails the first time
 * a schedule runs under an agent's own actor.
 *
 * The sharpest edge is buildConnectUrl. `actorKey()` prefers the user id
 * when both are present, so a URL carrying platformUserId AND agentId binds
 * to the user and throws the agent choice away with no error at all. These
 * pin that it is impossible to build that URL through this helper.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  listConnectOwners,
  buildConnectUrl,
  describeConnectionOwner,
} from '../src/connect-owner';

const ENV = {
  SPRIGR_PLATFORM_BASE: 'https://webhooks.example',
  SPRIGR_INSTALL_TOKEN: 'inst_1.sig',
};

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => impl(url, init)));
}

describe('buildConnectUrl', () => {
  it('carries the user id alone', () => {
    expect(buildConnectUrl({ startPath: '/oauth/start', platformUserId: 'usr_1' })).toBe(
      '/oauth/start?platformUserId=usr_1',
    );
  });

  it('carries the agent id alone', () => {
    expect(buildConnectUrl({ startPath: '/oauth/start', agentId: 'agt_1' })).toBe(
      '/oauth/start?agentId=agt_1',
    );
  });

  it('REFUSES to build a URL carrying both', () => {
    // The whole point. Silently preferring one is the original defect.
    expect(() =>
      buildConnectUrl({ startPath: '/oauth/start', platformUserId: 'usr_1', agentId: 'agt_1' }),
    ).toThrow(/never both/i);
  });

  it('treats a blank id as absent rather than as a choice', () => {
    // An empty string from a form field must not count as "the user chose
    // themselves", or a mis-wired page silently reintroduces the bug.
    expect(() => buildConnectUrl({ startPath: '/oauth/start', platformUserId: '  ' })).toThrow(
      /one of platformUserId or agentId/i,
    );
    expect(buildConnectUrl({ startPath: '/oauth/start', platformUserId: '  ', agentId: 'agt_1' })).toBe(
      '/oauth/start?agentId=agt_1',
    );
  });

  it('keeps caller extras', () => {
    const url = buildConnectUrl({
      startPath: '/oauth/start',
      agentId: 'agt_1',
      extra: { return_to: '/settings' },
    });
    expect(url).toContain('agentId=agt_1');
    expect(url).toContain('return_to=%2Fsettings');
  });
});

describe('listConnectOwners', () => {
  it('returns the platform owners and sends the install token', async () => {
    let seenAuth: string | undefined;
    stubFetch((url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      expect(url).toBe('https://webhooks.example/internal/wfp/connect-owners');
      return {
        ok: true,
        json: async () => ({
          owners: [
            {
              kind: 'shared',
              agentId: 'agt_ops',
              name: 'Operations',
              slug: 'operations',
              role: 'member',
              bindAs: { agentId: 'agt_ops' },
            },
          ],
        }),
      };
    });

    const owners = await listConnectOwners(ENV);
    expect(owners).toHaveLength(1);
    expect(owners[0]!.name).toBe('Operations');
    expect(seenAuth).toBe('Bearer inst_1.sig');
  });

  it('returns [] instead of throwing when the platform errors', async () => {
    // A settings page that cannot load an extra list of options must still
    // render "connect as me". Losing the page is the worse failure.
    stubFetch(() => ({ ok: false, json: async () => ({}) }));
    await expect(listConnectOwners(ENV)).resolves.toEqual([]);
  });

  it('returns [] instead of throwing when fetch rejects', async () => {
    stubFetch(() => {
      throw new Error('network down');
    });
    await expect(listConnectOwners(ENV)).resolves.toEqual([]);
  });

  it('does not call the platform at all without a token', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(listConnectOwners({ SPRIGR_PLATFORM_BASE: ENV.SPRIGR_PLATFORM_BASE })).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops malformed entries rather than surfacing half-built options', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        owners: [
          { name: 'no id' },
          // Has ids but no usable bindAs: rendering it would offer a button
          // that mints a token nothing can dispatch under.
          { kind: 'shared', agentId: 'agt_nobind', name: 'No bind', slug: 'n', role: 'member' },
          {
            kind: 'shared',
            agentId: 'agt_ok',
            name: 'Ops',
            slug: 'o',
            role: 'member',
            bindAs: { agentId: 'agt_ok' },
          },
        ],
      }),
    }));
    const owners = await listConnectOwners(ENV);
    expect(owners.map((o) => o.agentId)).toEqual(['agt_ok']);
  });
});

describe('describeConnectionOwner', () => {
  it('calls an agent-owned connection shared and usable by automations', () => {
    const d = describeConnectionOwner({ agentId: 'agt_1' });
    expect(d.scope).toBe('shared');
    expect(d.summary).toMatch(/workflows/i);
  });

  it('calls a user-owned connection personal, and says automations cannot use it', () => {
    // "Connected" on its own never told anyone this, which is why people
    // discovered it from a failing schedule instead of from the UI.
    const d = describeConnectionOwner({ platformUserId: 'usr_1' });
    expect(d.scope).toBe('personal');
    expect(d.summary).toMatch(/cannot/i);
  });

  it('treats a connection carrying both ids as personal, matching actorKey', () => {
    // Defensive: actorKey prefers the user, so the description must too or
    // the UI would claim a connection is shared when it is not.
    expect(describeConnectionOwner({ platformUserId: 'usr_1', agentId: 'agt_1' }).scope).toBe('personal');
  });

  it('asks for the personal option only when given a viewer', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ owners: [] }) };
    });

    await listConnectOwners(ENV);
    await listConnectOwners(ENV, { viewerUserId: 'usr_chris' });
    await listConnectOwners(ENV, { viewerUserId: 'anonymous' });

    expect(urls[0]).not.toContain('viewerUserId');
    expect(urls[1]).toContain('viewerUserId=usr_chris');
    // website-serve stamps the literal string "anonymous" for a signed-out
    // viewer; sending it would ask the platform to find a user called that.
    expect(urls[2]).not.toContain('viewerUserId');
  });
});

describe('buildConnectUrl from an owner', () => {
  it('uses the user id for a personal owner, NOT the companion agent id', () => {
    // The trap this whole API exists to close. A companion dispatches as
    // u:<owner>, so a token under a:<companionId> is unreachable forever.
    const url = buildConnectUrl({
      startPath: '/oauth/start',
      owner: {
        kind: 'personal',
        agentId: 'agt_chris',
        name: "Chris's AI",
        slug: 'chris',
        role: 'member',
        bindAs: { platformUserId: 'usr_chris' },
      },
    });
    expect(url).toBe('/oauth/start?platformUserId=usr_chris');
    expect(url).not.toContain('agt_chris');
  });

  it('uses the agent id for a shared owner', () => {
    const url = buildConnectUrl({
      startPath: '/oauth/start',
      owner: {
        kind: 'shared',
        agentId: 'agt_ops',
        name: 'Operations',
        slug: 'operations',
        role: 'member',
        bindAs: { agentId: 'agt_ops' },
      },
    });
    expect(url).toBe('/oauth/start?agentId=agt_ops');
  });
});
