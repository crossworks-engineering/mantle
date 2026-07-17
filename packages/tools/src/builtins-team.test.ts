import { describe, expect, it, vi } from 'vitest';
import { TEAM_REQUEST_TAG as CONTENT_TEAM_REQUEST_TAG, createTask } from '@mantle/content';
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
const forumCtx: ToolHandlerContext = {
  ownerId: 'owner-1',
  surface: { kind: 'forum', contactId: 'contact-9', contactName: 'Sam', topicId: 'topic-1' },
};

describe('team_request_create surface gate', () => {
  it('refuses off the team surfaces (web)', async () => {
    const r = await bySlug.team_request_create!.handler({ title: 't', body: 'b' }, ownerCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Team Chat \/ Team Forum surfaces/i);
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
    it(`${slug} refuses on the forum`, async () => {
      const r = await bySlug[slug]!.handler({ contactId: 'contact-9' }, forumCtx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/owner-side/i);
    });
  }
});

describe('team_request_create forum accept-path provenance', () => {
  it('stamps topicId + postId from the forum surface, never from model args', async () => {
    vi.mocked(createTask).mockClear();
    const forumWithPost: ToolHandlerContext = {
      ownerId: 'owner-1',
      surface: {
        kind: 'forum',
        contactId: 'contact-9',
        contactName: 'Sam',
        topicId: 'topic-42',
        inboundPostId: 'post-77',
      },
    };
    // A hostile model tries to forge provenance via args — must be ignored.
    const r = await bySlug.team_request_create!.handler(
      {
        title: 'Fix the RBI figure',
        body: 'The value in the table is wrong.',
        topicId: 'ATTACKER-TOPIC',
        contactId: 'ATTACKER-CONTACT',
      },
      forumWithPost,
    );
    expect(r.ok).toBe(true);
    expect(vi.mocked(createTask)).toHaveBeenCalledTimes(1);
    const [, taskArgs] = vi.mocked(createTask).mock.calls[0]!;
    const tr = (taskArgs.extraData as { teamRequest: Record<string, unknown> }).teamRequest;
    expect(tr.contactId).toBe('contact-9'); // from surface, not the forged arg
    expect(tr.topicId).toBe('topic-42');
    expect(tr.postId).toBe('post-77');
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
