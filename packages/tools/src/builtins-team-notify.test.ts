/**
 * team_notify / team_member_list — the responder's member-to-member reach.
 *
 * What must hold, in order of how much it would cost to get wrong:
 *   - the SENDER is the authenticated member, never a model argument. Anything
 *     else lets an injected prompt send as somebody else;
 *   - forum provenance (topic/post) is stamped from the surface for the same
 *     reason — and it is what makes "notify her about this" a link rather than
 *     a title to search for;
 *   - neither tool runs on the OWNER surfaces, where there is no member to act
 *     on behalf of;
 *   - recipients the gate refused are REPORTED, not silently dropped: a
 *     notification that never arrived while the responder says "done" is the
 *     failure mode this whole feature exists to remove;
 *   - the caller is excluded from the member list, so an ambiguous name can't
 *     resolve to the person asking.
 * The content layer is stubbed; the membership gate itself is its own concern.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', () => ({
  createTask: vi.fn(),
  listNotifiableMembers: vi.fn(),
  listTeamAccess: vi.fn(),
  listTeamMemberActivity: vi.fn(),
  listTeamThread: vi.fn(),
  nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  notifyMembers: vi.fn(),
  MAX_NOTIFICATION_BODY: 2000,
  MAX_NOTIFY_RECIPIENTS: 5,
}));

import { listNotifiableMembers, notifyMembers } from '@mantle/content';
import { TEAM_TOOLS } from './builtins-team';
import type { ToolHandlerContext } from './types';

const notify = TEAM_TOOLS.find((t) => t.slug === 'team_notify')!;
const memberList = TEAM_TOOLS.find((t) => t.slug === 'team_member_list')!;

const JAYA = 'contact-jaya';
const DEEPTHI = 'contact-deepthi';
const TOPIC = 'topic-pcms';
const POST = 'post-42';

/** A turn on the forum surface, as the member Jaya. */
const forumCtx: ToolHandlerContext = {
  ownerId: 'o1',
  surface: {
    kind: 'forum',
    contactId: JAYA,
    contactName: 'Jaya Sri Dadi',
    topicId: TOPIC,
    inboundPostId: POST,
  },
} as ToolHandlerContext;

/** The owner's own chat — no member context at all. */
const ownerCtx: ToolHandlerContext = { ownerId: 'o1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notifyMembers).mockResolvedValue({
    delivered: [{ recipientId: DEEPTHI, notificationId: 'n1' }],
    rejected: [],
  });
});

describe('team_notify', () => {
  it('sends as the AUTHENTICATED member and stamps the forum thread it came from', async () => {
    const res = await notify.handler({ recipient_ids: [DEEPTHI], body: 'Please check this.' }, forumCtx);

    expect(res.ok).toBe(true);
    expect(notifyMembers).toHaveBeenCalledWith('o1', {
      recipientIds: [DEEPTHI],
      senderId: JAYA,
      senderName: 'Jaya Sri Dadi',
      body: 'Please check this.',
      topicId: TOPIC,
      postId: POST,
    });
  });

  it('ignores a sender or topic supplied as an argument — provenance is not model input', async () => {
    await notify.handler(
      {
        recipient_ids: [DEEPTHI],
        body: 'hi',
        // An injected prompt's best attempt at masquerading.
        sender_id: 'contact-someone-else',
        senderId: 'contact-someone-else',
        topic_id: 'topic-elsewhere',
      },
      forumCtx,
    );

    const call = vi.mocked(notifyMembers).mock.calls[0]![1];
    expect(call.senderId).toBe(JAYA);
    expect(call.topicId).toBe(TOPIC);
  });

  it('reports recipients the gate refused instead of dropping them silently', async () => {
    vi.mocked(notifyMembers).mockResolvedValue({
      delivered: [{ recipientId: DEEPTHI, notificationId: 'n1' }],
      rejected: ['contact-revoked'],
    });

    const res = await notify.handler(
      { recipient_ids: [DEEPTHI, 'contact-revoked'], body: 'hi' },
      forumCtx,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output).toMatchObject({ notified: 1, not_notified: ['contact-revoked'] });
  });

  it('fails loudly when NOBODY could be reached', async () => {
    vi.mocked(notifyMembers).mockResolvedValue({ delivered: [], rejected: ['ghost'] });

    const res = await notify.handler({ recipient_ids: ['ghost'], body: 'hi' }, forumCtx);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // "ok with notified: 0" would read to the model as success.
    expect(res.error).toMatch(/nobody was notified/i);
    expect(res.error).toMatch(/team_member_list/);
  });

  it('refuses on the owner surface — there is no member to send on behalf of', async () => {
    const res = await notify.handler({ recipient_ids: [DEEPTHI], body: 'hi' }, ownerCtx);

    expect(res.ok).toBe(false);
    expect(notifyMembers).not.toHaveBeenCalled();
  });

  it('requires recipient ids, and says where to get them', async () => {
    const res = await notify.handler({ recipient_ids: [], body: 'hi' }, forumCtx);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/team_member_list/);
    expect(notifyMembers).not.toHaveBeenCalled();
  });

  it('carries no topic on the Team Chat surface, which has no thread', async () => {
    const chatCtx = {
      ownerId: 'o1',
      surface: { kind: 'team', contactId: JAYA, contactName: 'Jaya' },
    } as ToolHandlerContext;

    await notify.handler({ recipient_ids: [DEEPTHI], body: 'hi' }, chatCtx);

    const call = vi.mocked(notifyMembers).mock.calls[0]![1];
    expect(call.topicId).toBeNull();
    expect(call.postId).toBeNull();
  });
});

describe('team_member_list', () => {
  beforeEach(() => {
    vi.mocked(listNotifiableMembers).mockResolvedValue([
      { id: JAYA, name: 'Jaya Sri Dadi' },
      { id: DEEPTHI, name: 'Deepthi' },
    ]);
  });

  it('excludes the caller, so an ambiguous name cannot resolve to the asker', async () => {
    const res = await memberList.handler({}, forumCtx);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { members } = res.output as { members: { id: string }[] };
    expect(members.map((m) => m.id)).toEqual([DEEPTHI]);
  });

  it('refuses on the owner surface — team_chat_list is the owner-side view', async () => {
    const res = await memberList.handler({}, ownerCtx);

    expect(res.ok).toBe(false);
    expect(listNotifiableMembers).not.toHaveBeenCalled();
  });
});
