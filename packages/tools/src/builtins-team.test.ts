import { describe, expect, it, vi } from 'vitest';
import {
  TEAM_REQUEST_TAG as CONTENT_TEAM_REQUEST_TAG,
  createTask,
  listLoginPortalThread,
  listMemberChatActivity,
  listTeamAccess,
  listTeamMemberActivity,
  listTeamThread,
} from '@mantle/content';
import { TEAM_TOOLS, TEAM_REQUEST_TAG } from './builtins-team';
import type { ToolHandlerContext } from './types';

// Override only the write + url helpers so the accept-path test can inspect the
// provenance stamped into the task, without a live DB. Everything else
// (TEAM_REQUEST_TAG, listTeamThread, …) stays real.
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createTask: vi.fn(async (_ownerId: string, args: { title: string }) => ({
      id: 'task-new',
      title: args.title,
    })),
    nodeUrl: (id: string) => `/n/${id}`,
    listTeamThread: vi.fn(async () => []),
    listLoginPortalThread: vi.fn(async () => null),
    listTeamAccess: vi.fn(async () => []),
    listMemberChatActivity: vi.fn(async () => []),
    listTeamMemberActivity: vi.fn(async () => []),
  };
});

/**
 * Surface gating for the team tools — the boundary that keeps the two sides
 * apart. These paths must refuse BEFORE any data access:
 *   - team_request_create runs ONLY on the team surface (provenance comes
 *     from the authenticated surface context, so off-surface calls are
 *     meaningless and refused);
 *   - the owner-side team_chat_* / team_access_list tools must refuse ON the
 *     team surface — granting them to the team responder by mistake would
 *     leak other members' threads, and this gate is the backstop even then.
 */

const bySlug = Object.fromEntries(TEAM_TOOLS.map((t) => [t.slug, t]));

const ownerCtx: ToolHandlerContext = { ownerId: 'owner-1', surface: { kind: 'web' } };
const teamCtx: ToolHandlerContext = {
  ownerId: 'owner-1',
  surface: { kind: 'team', contactId: 'contact-9', contactName: 'Sam' },
};

describe('team_request_create surface gate', () => {
  it('refuses off the team surfaces (web)', async () => {
    const r = await bySlug.team_request_create!.handler({ title: 't', body: 'b' }, ownerCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/only runs on the team surface/i);
  });

  it('refuses with no surface at all (background callers)', async () => {
    const r = await bySlug.team_request_create!.handler(
      { title: 't', body: 'b' },
      { ownerId: 'owner-1' },
    );
    expect(r.ok).toBe(false);
  });

  it('requires title and body before touching anything', async () => {
    const r = await bySlug.team_request_create!.handler({ title: '  ' }, teamCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/title and body/i);
  });
});

describe('owner-side team tools refuse on the team surfaces', () => {
  for (const slug of ['team_chat_list', 'team_chat_read', 'team_access_list'] as const) {
    it(`${slug} refuses on team chat`, async () => {
      const r = await bySlug[slug]!.handler({ contactId: 'contact-9' }, teamCtx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/owner-side/i);
    });
  }
});

describe('team_request_create member accept-path provenance', () => {
  it('stamps the member login from the surface, never from model args, and no forum ids', async () => {
    vi.mocked(createTask).mockClear();
    const memberCtx: ToolHandlerContext = {
      ownerId: 'owner-1',
      surface: { kind: 'team', loginId: 'login-7', contactName: 'Sam' },
    };
    // A hostile model tries to forge provenance via args — must be ignored.
    const r = await bySlug.team_request_create!.handler(
      {
        title: 'Fix the RBI figure',
        body: 'The value in the table is wrong.',
        topicId: 'ATTACKER-TOPIC',
        contactId: 'ATTACKER-CONTACT',
        loginId: 'ATTACKER-LOGIN',
      },
      memberCtx,
    );
    expect(r.ok).toBe(true);
    expect(vi.mocked(createTask)).toHaveBeenCalledTimes(1);
    const [, taskArgs] = vi.mocked(createTask).mock.calls[0]!;
    const tr = (taskArgs.extraData as { teamRequest: Record<string, unknown> }).teamRequest;
    expect(tr.loginId).toBe('login-7'); // from surface, not the forged arg
    expect(tr.contactId).toBeNull();
    // The forum branch is gone (member logins Phase 6): no topic or post ids.
    expect(tr).not.toHaveProperty('topicId');
    expect(tr).not.toHaveProperty('postId');
    expect(taskArgs.tags).toContain(TEAM_REQUEST_TAG);
  });
});

describe('team-request tag', () => {
  it('is the same literal the content requests view filters on (no drift)', () => {
    // team_request_create tags with this; listTeamRequests filters on it. They
    // live in different packages, so lock them together.
    expect(TEAM_REQUEST_TAG).toBe(CONTENT_TEAM_REQUEST_TAG);
    expect(TEAM_REQUEST_TAG).toBe('team-request');
  });
});

describe('owner-side chat tools read member LOGIN threads (users are the team)', () => {
  const LOGIN = '11111111-2222-4333-8444-555555555555';

  it("team_chat_read with loginId reads that login's thread", async () => {
    vi.mocked(listTeamThread).mockClear();
    const r = await bySlug.team_chat_read!.handler({ loginId: LOGIN, limit: 10 }, ownerCtx);
    expect(r.ok).toBe(true);
    expect(listTeamThread).toHaveBeenCalledWith('owner-1', '', { limit: 10, loginId: LOGIN });
  });

  it('team_chat_read with contactId reads the old portal thread (history)', async () => {
    vi.mocked(listTeamThread).mockClear();
    vi.mocked(listLoginPortalThread).mockClear();
    const r = await bySlug.team_chat_read!.handler({ contactId: 'contact-9' }, ownerCtx);
    expect(r.ok).toBe(true);
    expect(listTeamThread).toHaveBeenCalledWith('owner-1', 'contact-9', { limit: 50 });
    expect(listLoginPortalThread).not.toHaveBeenCalled();
  });

  it("team_chat_read with loginId adds the login's portal chat apart, on the first window only", async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const line = (text: string) =>
      ({
        id: text,
        direction: 'inbound',
        text,
        channel: 'web',
        traceId: null,
        createdAt: at,
      }) as never;
    vi.mocked(listTeamThread).mockResolvedValueOnce([line('live')]);
    vi.mocked(listLoginPortalThread).mockClear();
    vi.mocked(listLoginPortalThread).mockResolvedValueOnce({
      contactId: 'c-old',
      messages: [line('portal')],
    });
    const r = await bySlug.team_chat_read!.handler({ loginId: LOGIN }, ownerCtx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as {
      messages: { text: string }[];
      portal_history: { contactId: string; note: string; messages: { text: string }[] };
    };
    expect(out.messages.map((m) => m.text)).toEqual(['live']);
    expect(out.portal_history.contactId).toBe('c-old');
    expect(out.portal_history.messages.map((m) => m.text)).toEqual(['portal']);
    expect(out.portal_history.note).toMatch(/not part of their current chat/);
    expect(listLoginPortalThread).toHaveBeenCalledWith('owner-1', LOGIN, { limit: 50 });

    vi.mocked(listLoginPortalThread).mockClear();
    const older = await bySlug.team_chat_read!.handler(
      { loginId: LOGIN, before: at.toISOString() },
      ownerCtx,
    );
    expect(older.ok && (older.output as Record<string, unknown>).portal_history).toBeFalsy();
    expect(listLoginPortalThread).not.toHaveBeenCalled();
  });

  it('team_access_list narrows by loginId and refuses one that is not a login id', async () => {
    vi.mocked(listTeamAccess).mockClear();
    const r = await bySlug.team_access_list!.handler({ loginId: LOGIN, limit: 5 }, ownerCtx);
    expect(r.ok).toBe(true);
    expect(listTeamAccess).toHaveBeenCalledWith('owner-1', {
      contactId: undefined,
      loginId: LOGIN,
      limit: 5,
    });
    const bad = await bySlug.team_access_list!.handler({ loginId: 'sam' }, ownerCtx);
    expect(bad.ok).toBe(false);
    expect(listTeamAccess).toHaveBeenCalledTimes(1);
  });

  it('team_chat_read needs one of the two, and a login id must be a uuid', async () => {
    const none = await bySlug.team_chat_read!.handler({}, ownerCtx);
    expect(none.ok).toBe(false);
    const bad = await bySlug.team_chat_read!.handler({ loginId: 'sam' }, ownerCtx);
    expect(bad.ok).toBe(false);
  });

  it('team_chat_list lists member logins, and portal threads only when they have messages', async () => {
    vi.mocked(listMemberChatActivity).mockResolvedValueOnce([
      {
        loginId: LOGIN,
        name: 'sam',
        email: 'sam@example.com',
        active: true,
        lastMessageAt: null,
        lastMessageText: null,
        lastMessageDirection: null,
        messageCount: 0,
      },
    ]);
    vi.mocked(listTeamMemberActivity).mockResolvedValueOnce([
      { contactId: 'c-old', contactName: 'Old', messageCount: 3, lastMessageAt: 'x' },
      { contactId: 'c-none', contactName: 'None', messageCount: 0, lastMessageAt: null },
    ] as never);
    const r = await bySlug.team_chat_list!.handler({}, ownerCtx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as { count: number; portal_archive: { contactId: string }[] };
    expect(out.count).toBe(1);
    expect(out.portal_archive.map((p) => p.contactId)).toEqual(['c-old']);
  });
});
