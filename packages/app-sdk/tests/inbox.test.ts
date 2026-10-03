import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  connectComplete,
  defineInboxSendHandler,
  withSprigrInboxFallback,
  type InboxSendConnection,
  type InboxSendV1Args,
} from '../src/index';

interface Conn extends InboxSendConnection { id: string; emails: string[] }

const CONNS: Conn[] = [
  { id: 'c_alice', actorKey: 'u:alice', emails: ['alice@x.io', 'alias@x.io'] },
  { id: 'c_bob', actorKey: 'u:bob', emails: ['bob@x.io'] },
  { id: 'c_desk', actorKey: 'a:agt_desk', emails: ['desk@x.io'] },
];

function handler() {
  const send = vi.fn(async (_env: unknown, conn: Conn, args: InboxSendV1Args) => ({ message_id: `fm:${conn.id}:new`, internet_message_id: '<n@x.io>', _subject: args.subject }));
  const h = defineInboxSendHandler<unknown, Conn>({
    connectionForSourceId: async (_env, sourceId) => CONNS.find((c) => sourceId.startsWith(`fm:${c.id}:`)) ?? null,
    connectionForActor: async (_env, key, from) =>
      CONNS.find((c) => c.actorKey === key && (!from || c.emails.includes(from))) ?? null,
    send,
  });
  return { h, send };
}

const base = { contract: 'sprigr.inbox.send/v1', body_text: 'hi', subject: 'S', to: [{ email: 'c@y.io' }] };

describe('defineInboxSendHandler: the mailbox-owner rule', () => {
  it("replies from the owner's connection when the writer owns it", async () => {
    const { h, send } = handler();
    const r = await h({ ...base, reply: { source_id: 'fm:c_alice:E1', references: [] }, actor: { platformUserId: 'alice' } }, {});
    expect(r.ok).toBe(true);
    expect(send.mock.calls[0][1].id).toBe('c_alice');
  });

  it("refuses a reply on someone else's mailbox, and never sends from the writer's own instead", async () => {
    const { h, send } = handler();
    const r = await h({ ...base, reply: { source_id: 'fm:c_alice:E1', references: [] }, actor: { platformUserId: 'bob' } }, {});
    expect(r).toMatchObject({ ok: false, status: 412 });
    expect((r as { error: string }).error).toMatch(/^not_your_mailbox/);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts an agent-keyed mailbox for an actor carrying that agent', async () => {
    const { h, send } = handler();
    const r = await h({ ...base, reply: { source_id: 'fm:c_desk:E2', references: [] }, actor: { platformUserId: 'bob', agentId: 'agt_desk' } }, {});
    expect(r.ok).toBe(true);
    expect(send.mock.calls[0][1].id).toBe('c_desk');
  });

  it("sends a new mail from the writer's connection matching from_email", async () => {
    const { h, send } = handler();
    const r = await h({ ...base, from_email: 'alias@x.io', actor: { platformUserId: 'alice' } }, {});
    expect(r.ok).toBe(true);
    expect(send.mock.calls[0][1].id).toBe('c_alice');
  });

  it("refuses a from_email the writer has no connection for", async () => {
    const { h, send } = handler();
    const r = await h({ ...base, from_email: 'bob@x.io', actor: { platformUserId: 'alice' } }, {});
    expect((r as { error: string }).error).toMatch(/^not_connected/);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses with no stamped actor, and on the wrong contract', async () => {
    const { h } = handler();
    expect((await h({ ...base }, {}) as { error: string }).error).toMatch(/^no_caller_identity/);
    expect(await h({ ...base, contract: 'v0', actor: { platformUserId: 'alice' } }, {})).toMatchObject({ ok: false, status: 400 });
  });
});

describe('withSprigrInboxFallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('wires append over the install-token bridge on an inline route and throws on a non-2xx', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, threadsCreated: 1, messagesLinked: 1, threadIds: ['t1'] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = withSprigrInboxFallback({ SPRIGR_PLATFORM_BASE: 'https://p.example/', SPRIGR_INSTALL_TOKEN: 'inst.mac' }) as { SPRIGR?: { inbox?: { append: (r: unknown) => Promise<unknown> } } };
    const r = await env.SPRIGR!.inbox!.append({ channel: 'acme_mail', messages: [] });
    expect(r).toEqual({ ok: true, threadsCreated: 1, messagesLinked: 1, threadIds: ['t1'] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://p.example/internal/wfp/inbox/append');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'channel_not_owned' }), { status: 403 }));
    await expect(env.SPRIGR!.inbox!.append({ messages: [] })).rejects.toThrow(/403 channel_not_owned/);
  });

  it('leaves env untouched with no bridge bindings (fail closed)', () => {
    const env = { DB: 1 };
    expect(withSprigrInboxFallback(env)).toBe(env);
  });
});

describe('connectComplete', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('posts the viewer token to the platform with the install bearer', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, actor_key: 'u:alice', identities: { inserted: 1, updated: 0, deleted: 0 }, existing_mailboxes: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await connectComplete(
      { SPRIGR_PLATFORM_BASE: 'https://p.example', SPRIGR_INSTALL_TOKEN: 'inst.mac' },
      { viewer_token: 'svc1.a.b', account: { email: 'alice@x.io' } },
    );
    expect(r.actor_key).toBe('u:alice');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://p.example/internal/wfp/connect/complete');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer inst.mac');
    expect(JSON.parse(init.body as string).viewer_token).toBe('svc1.a.b');
  });
});
