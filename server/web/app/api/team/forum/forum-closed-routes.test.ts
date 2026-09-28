/**
 * The team forum is closed (member logins, Phase 6): every write answers 410
 * `forum-closed` with the invite hint, before any rate limit, budget, body
 * parse or store call; the forum turn enqueue refuses; an unauthenticated
 * caller still gets its 401 (the auth sweeps rely on that). No database: the
 * credential and the store are stood in, and each store write is a spy that
 * must never be called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CONTACT = '66666666-6666-4666-8666-666666666666';
const TOPIC = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  caller: null as null | { ownerId: string; contactId: string; channel: 'web' | 'api' },
  writes: [] as string[],
  access: [] as Array<Record<string, unknown>>,
  enqueued: 0,
}));

vi.mock('@/lib/team-chat-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTeamChatCaller: vi.fn(async () => h.caller),
  teamCallerName: vi.fn(async () => 'Pat'),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: vi.fn(async () => ({
    enqueue: vi.fn(async () => {
      h.enqueued++;
      return { getResult: async () => ({ outbound: null }) };
    }),
  })),
}));

vi.mock('@mantle/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content')>();
  const write = (name: string) =>
    vi.fn(async () => {
      h.writes.push(name);
      throw new Error(`${name} must not run while the forum is closed`);
    });
  return {
    ...real,
    recordTeamAccess: vi.fn((entry: Record<string, unknown>) => h.access.push(entry)),
    countForumMemberPostsSince: write('countForumMemberPostsSince'),
    createForumTopic: write('createForumTopic'),
    appendForumPost: write('appendForumPost'),
    getForumTopic: write('getForumTopic'),
    stageForumUploadsWithinBudget: write('stageForumUploadsWithinBudget'),
    setForumTopicStatus: write('setForumTopicStatus'),
    loadProfilePreferences: write('loadProfilePreferences'),
  };
});

beforeEach(() => {
  h.caller = { ownerId: ANCHOR, contactId: CONTACT, channel: 'web' };
  h.writes = [];
  h.access = [];
  h.enqueued = 0;
});

const json = (url: string, body: unknown) =>
  new Request(`https://brain.example.invalid${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const expectClosed = async (res: Response) => {
  expect(res.status).toBe(410);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.reason).toBe('forum-closed');
  expect(body.error).toMatch(/forum is closed/i);
  expect(body.inviteHint).toMatch(/invite/i);
};

describe('the closed forum', () => {
  it('refuses a new topic', async () => {
    const { POST } = await import('./topics/route');
    await expectClosed(await POST(json('/api/team/forum/topics', { title: 'Hi', body: 'hello' })));
    expect(h.writes).toEqual([]);
    expect(h.enqueued).toBe(0);
    expect(h.access).toEqual([
      expect.objectContaining({
        ownerId: ANCHOR,
        contactId: CONTACT,
        kind: 'denied',
        detail: expect.objectContaining({ reason: 'forum_closed' }),
      }),
    ]);
  });

  it('refuses a reply', async () => {
    const { POST } = await import('./topics/[id]/posts/route');
    const res = await POST(json(`/api/team/forum/topics/${TOPIC}/posts`, { text: 'more' }), {
      params: Promise.resolve({ id: TOPIC }),
    });
    await expectClosed(res);
    expect(h.writes).toEqual([]);
    expect(h.enqueued).toBe(0);
  });

  it('refuses an upload', async () => {
    const { POST } = await import('./uploads/route');
    const form = new FormData();
    form.append('file', new Blob(['bytes'], { type: 'text/plain' }), 'a.txt');
    const res = await POST(
      new Request('https://brain.example.invalid/api/team/forum/uploads', {
        method: 'POST',
        body: form,
      }),
    );
    await expectClosed(res);
    expect(h.writes).toEqual([]);
  });

  it("refuses the admin's post", async () => {
    const { POST } = await import('../../team-admin/forum/post/route');
    await expectClosed(
      await POST(json('/api/team-admin/forum/post', { topicId: TOPIC, text: 'x' })),
    );
    expect(h.writes).toEqual([]);
  });

  it('still answers 401 to a caller with no team credential', async () => {
    h.caller = null;
    const topics = await import('./topics/route');
    const posts = await import('./topics/[id]/posts/route');
    const uploads = await import('./uploads/route');
    const req = json('/api/team/forum/topics', { title: 'Hi', body: 'hello' });
    expect((await topics.POST(req)).status).toBe(401);
    expect((await posts.POST(req, { params: Promise.resolve({ id: TOPIC }) })).status).toBe(401);
    expect((await uploads.POST(req)).status).toBe(401);
    expect(h.access).toEqual([]);
  });

  it('refuses to enqueue a forum turn', async () => {
    const { enqueueForumTurn } = await import('@/lib/forum-turn-enqueue');
    const { ForumClosedError } = await import('@/lib/forum-closed');
    await expect(
      enqueueForumTurn({
        ownerId: ANCHOR,
        contactId: CONTACT,
        topicId: TOPIC,
        inboundPostId: TOPIC,
        channel: 'web',
      }),
    ).rejects.toBeInstanceOf(ForumClosedError);
    expect(h.enqueued).toBe(0);
  });
});
