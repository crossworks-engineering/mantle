/**
 * Behavioural tests for team_request_create's WRITE path. builtins-team.test.ts
 * pins the surface gate, the arg check and the forum-side provenance stamp;
 * this file pins what actually lands in the task row and for whom.
 *
 * The tool is the ONLY write the team responder holds, and its whole safety
 * story is that the row is fully determined by the authenticated surface plus
 * two model-supplied strings:
 *
 *  - the task is created under the CALLER's owner id (the brain the member is
 *    talking to), tagged `team-request`, with the member named in the body so
 *    a specialist knows who asked;
 *  - the inbound message id and its attachments come from the member's own
 *    thread (`listTeamThread` scoped to owner + contact), never from args, and
 *    the thread is not read at all when the turn has no inbound message;
 *  - a store failure is reported, not thrown.
 *
 * The content layer is stubbed; the tool's assembly of the row is real.
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

import { createTask, listTeamThread } from '@mantle/content';
import { TEAM_TOOLS, TEAM_REQUEST_TAG } from './builtins-team';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const request = TEAM_TOOLS.find((t) => t.slug === 'team_request_create')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

type TaskArgs = Parameters<typeof createTask>[1];
type TeamRequest = Record<string, unknown>;

/** The single createTask call: owner it was made for, and the row args. */
function written(): { ownerId: string; args: TaskArgs; teamRequest: TeamRequest } {
  expect(createTask).toHaveBeenCalledTimes(1);
  const [ownerId, args] = vi.mocked(createTask).mock.calls[0]!;
  const teamRequest = (args.extraData as { teamRequest: TeamRequest }).teamRequest;
  return { ownerId, args, teamRequest };
}

const teamCtx: ToolHandlerContext = {
  ownerId: 'owner-1',
  surface: { kind: 'team', contactId: 'contact-9', contactName: 'Sam' },
};
const ARGS = { title: 'Update RBI report 30257', body: 'The inspection dates moved.' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createTask).mockImplementation(
    async (_ownerId, args) => ({ id: 'task-new', title: args.title }) as never,
  );
  vi.mocked(listTeamThread).mockResolvedValue([]);
});

describe('team_request_create write path', () => {
  it('files one task under the caller owner, tagged team-request, naming the member', async () => {
    const res = await request.handler(ARGS, teamCtx);
    expect(outputOf(res)).toEqual({
      id: 'task-new',
      title: ARGS.title,
      status: 'queued for specialist review',
    });
    const { ownerId, args, teamRequest } = written();
    expect(ownerId).toBe('owner-1');
    expect(args).toMatchObject({ title: ARGS.title, priority: 'normal', tags: [TEAM_REQUEST_TAG] });
    expect(String(args.body).startsWith('**Team request from Sam.**')).toBe(true);
    expect(args.body).toContain(ARGS.body);
    expect(teamRequest).toMatchObject({
      contactId: 'contact-9',
      contactName: 'Sam',
      threadMessageId: null,
      topicId: null,
      postId: null,
      attachments: [],
    });
    expect(typeof teamRequest.filedAt).toBe('string');
  });

  it('passes the priority through', async () => {
    outputOf(await request.handler({ ...ARGS, priority: 'high' }, teamCtx));
    expect(written().args.priority).toBe('high');
  });

  it('falls back to "a team member" when the surface carries no name', async () => {
    outputOf(
      await request.handler(ARGS, {
        ownerId: 'owner-1',
        surface: { kind: 'team', contactId: 'contact-9' },
      }),
    );
    const { args, teamRequest } = written();
    expect(String(args.body).startsWith('**Team request from a team member.**')).toBe(true);
    expect(teamRequest.contactName).toBeNull();
  });

  it('does not read the thread when the turn has no inbound message', async () => {
    outputOf(await request.handler(ARGS, teamCtx));
    expect(listTeamThread).not.toHaveBeenCalled();
  });

  it('stamps the inbound message and its attachments from the member thread, scoped to owner + contact', async () => {
    vi.mocked(listTeamThread).mockResolvedValue([
      { id: 'm0', attachments: [{ nodeId: 'someone-elses' }] },
      { id: 'm1', attachments: [{ nodeId: 'n1' }, { nodeId: '' }, { name: 'no node' }] },
    ] as never);
    const ctx: ToolHandlerContext = {
      ownerId: 'owner-1',
      surface: { kind: 'team', contactId: 'contact-9', contactName: 'Sam', inboundMessageId: 'm1' },
    };
    const setMeta = vi.fn();
    outputOf(
      await request.handler(ARGS, {
        ...ctx,
        step: { setMeta, setOutput: vi.fn(), addTokens: vi.fn(), addCost: vi.fn() },
      }),
    );
    expect(listTeamThread).toHaveBeenCalledWith('owner-1', 'contact-9', { limit: 200 });
    const { args, teamRequest } = written();
    expect(teamRequest.threadMessageId).toBe('m1');
    expect(teamRequest.attachments).toEqual(['n1']);
    expect(args.body).toContain('**Attachments:**');
    expect(args.body).toContain('[attached file](https://brain.test/n/n1)');
    expect(args.body).not.toContain('someone-elses');
    expect(setMeta).toHaveBeenCalledWith({ contactId: 'contact-9', attachments: 1 });
  });

  it('records no attachments when the inbound message is not in the thread', async () => {
    vi.mocked(listTeamThread).mockResolvedValue([{ id: 'other', attachments: [] }] as never);
    outputOf(
      await request.handler(ARGS, {
        ownerId: 'owner-1',
        surface: { kind: 'team', contactId: 'contact-9', inboundMessageId: 'gone' },
      }),
    );
    const { args, teamRequest } = written();
    expect(teamRequest.threadMessageId).toBe('gone');
    expect(teamRequest.attachments).toEqual([]);
    expect(args.body).not.toContain('**Attachments:**');
  });

  it('reports a store failure as a tool error', async () => {
    vi.mocked(createTask).mockRejectedValue(new Error('disk full'));
    expect(errorOf(await request.handler(ARGS, teamCtx))).toBe('disk full');
  });
});
