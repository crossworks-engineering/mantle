/**
 * Team Chat tools.
 *
 * `team_request_create` — the ONLY write tool the team responder holds. A team
 * member's change request ("please update X, here's the file") becomes a task
 * tagged `team-request` in the specialists' review queue. Provenance (which
 * contact, which thread message, which attachments) is stamped from the turn's
 * `surface` context — NEVER from model args — so an injected prompt can't file
 * a request that masquerades as someone else or hides its origin. Worst-case
 * injection outcome: a clearly-labeled task in a human-reviewed queue.
 *
 * `team_member_list` / `team_notify` — the member-to-member reach. A member
 * could always ASK the responder to tell a colleague something, and it could
 * only answer that it had no way to (a real Pinnacle forum topic, 2026-07-21).
 * Same provenance discipline as above: the SENDER is the authenticated member,
 * the forum topic/post is stamped from the surface, and a recipient is always
 * an id from `team_member_list` re-verified against live membership — there is
 * no free-text address, so the blast radius is the brain's own team.
 *
 * `team_chat_list` / `team_chat_read` / `team_access_list` — OWNER-side admin
 * tools (granted via the `team-admin` group to the persona, never to the team
 * responder). They make team activity queryable by the brain: "what has Sam
 * asked about this week?".
 */

import {
  createTask,
  listNotifiableMembers,
  listTeamAccess,
  listTeamMemberActivity,
  listTeamThread,
  nodeUrl,
  notifyMembers,
  MAX_NOTIFICATION_BODY,
  MAX_NOTIFY_RECIPIENTS,
  type TaskPriority,
} from '@mantle/content';
import type { ToolPrecondition, BuiltinToolDef, ToolHandlerResult } from './types';
import { str, strArr } from './coerce';

const TEAM_CONTACT_ID_PRE: readonly ToolPrecondition[] = [
  {
    kind: 'node_exists',
    param: 'contactId',
    nodeType: 'contact',
    lookup: 'team_chat_list / contact_find',
  },
];

function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function numOpt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export const TEAM_REQUEST_TAG = 'team-request';

const team_request_create: BuiltinToolDef = {
  slug: 'team_request_create',
  name: 'File a team change request',
  description:
    'File a change/update/correction REQUEST from the team member you are serving into the review queue for a brain specialist. You cannot modify any content yourself — this is your only write action. ' +
    "`title` is a short imperative summary of what they want changed ('Update RBI report 30257 with revised inspection dates'); `body` restates the request in full: WHAT should change, WHERE (link the pages/notes/tables you found), and the member's reasoning. Any files the member attached to their message are linked to the request automatically. " +
    'After filing, tell the member their request is queued for specialist review — do not promise it will be applied.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          "Short imperative summary of the requested change, e.g. 'Update RBI report 30257 with revised inspection dates'.",
      },
      body: {
        type: 'string',
        description:
          'The full request: what to change, where (with node links), and why — written so a specialist can act without reading the chat.',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: "How urgently the specialists should review it; defaults to 'normal'.",
      },
    },
    required: ['title', 'body'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const surface = ctx.surface;
    if (surface?.kind !== 'team' && surface?.kind !== 'forum') {
      return {
        ok: false,
        error:
          'team_request_create only runs on the Team Chat / Team Forum surfaces — the requesting team member must be the one asking.',
      };
    }
    const title = str(input.title).trim();
    const body = str(input.body).trim();
    if (!title || !body) return { ok: false, error: 'title and body required' };

    // Provenance comes from the authenticated surface context, not the model.
    const { contactId, contactName } = surface;
    const inboundMessageId = surface.kind === 'team' ? surface.inboundMessageId : undefined;
    let attachments: { nodeId: string }[] = [];
    if (inboundMessageId) {
      const [msg] = await listTeamThread(ctx.ownerId, contactId, { limit: 200 }).then((rows) => [
        rows.find((r) => r.id === inboundMessageId),
      ]);
      attachments = (msg?.attachments ?? [])
        .filter((a) => typeof a.nodeId === 'string' && a.nodeId.length > 0)
        .map((a) => ({ nodeId: a.nodeId! }));
    }

    try {
      const requester = contactName ? `${contactName}` : 'a team member';
      const attachmentLines = attachments.length
        ? `\n\n**Attachments:**\n${attachments.map((a) => `- [attached file](${nodeUrl(a.nodeId)})`).join('\n')}`
        : '';
      const row = await createTask(ctx.ownerId, {
        title,
        body: `**Team request from ${requester}.**\n\n${body}${attachmentLines}`,
        priority: (strOpt(input.priority) as TaskPriority | undefined) ?? 'normal',
        tags: [TEAM_REQUEST_TAG],
        extraData: {
          teamRequest: {
            contactId,
            contactName: contactName ?? null,
            threadMessageId: inboundMessageId ?? null,
            // Forum provenance — which shared topic/post the ask came from,
            // so Phase 2's review round-trip can deliver the owner's reply
            // back into that thread.
            topicId: surface.kind === 'forum' ? surface.topicId : null,
            postId: surface.kind === 'forum' ? (surface.inboundPostId ?? null) : null,
            attachments: attachments.map((a) => a.nodeId),
            filedAt: new Date().toISOString(),
          },
        },
      });
      ctx.step?.setMeta({ contactId, attachments: attachments.length });
      return {
        ok: true,
        output: {
          id: row.id,
          title: row.title,
          status: 'queued for specialist review',
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/** Shared surface guard: these tools act AS the member currently talking, so
 *  they only run where an authenticated member context exists. Returns the
 *  member's identity, or a teaching error for the owner-side surfaces. */
function memberSurfaceOf(
  ctx: { surface?: { kind: string; contactId?: string; contactName?: string } },
  slug: string,
): { contactId: string; contactName?: string } | ToolHandlerResult {
  const s = ctx.surface;
  if ((s?.kind !== 'team' && s?.kind !== 'forum') || !s.contactId) {
    return {
      ok: false,
      error: `${slug} only runs on the Team Chat / Team Forum surfaces — it acts on behalf of the member you are talking to, so there must be one.`,
    };
  }
  return { contactId: s.contactId, ...(s.contactName ? { contactName: s.contactName } : {}) };
}

const team_member_list: BuiltinToolDef = {
  slug: 'team_member_list',
  readOnly: true,
  name: 'List team members you can notify',
  description:
    "List this brain's team members — display name and id only — so you can resolve a name the member mentioned ('let Deepthi know') to a `team_notify` recipient. Call it when you need an id, not routinely. Names may be ambiguous or absent: if you can't match one confidently, ASK the member which colleague they meant rather than guessing. For the owner-side view of team activity use `team_chat_list` instead.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    const who = memberSurfaceOf(ctx, 'team_member_list');
    if ('ok' in who) return who;
    const all = await listNotifiableMembers(ctx.ownerId);
    // Drop the caller: "notify myself" is never the ask, and offering it back
    // invites the model to resolve an ambiguous name to the person in front
    // of it.
    const members = all.filter((m) => m.id !== who.contactId);
    ctx.step?.setMeta({ count: members.length });
    return { ok: true, output: { members, count: members.length } };
  },
};

const team_notify: BuiltinToolDef = {
  slug: 'team_notify',
  name: 'Notify a team member',
  description:
    "Send a short notification to one or more team members on behalf of the member you're talking to ('can you ask Deepthi to check this?'). It lands in the recipient's dash — where they can REPLY to it — and, if they've allowed browser notifications, as one of those too. Recipient ids come from `team_member_list`; there is no free-text address, and only live members of this brain can be reached. When you're in a forum topic the link back to it is attached automatically, so write the message about WHAT you need from them, not about where to find it. Tell the member who was notified — and name anyone who wasn't.",
  inputSchema: {
    type: 'object',
    properties: {
      recipient_ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_NOTIFY_RECIPIENTS,
        description: "Contact ids from `team_member_list`, e.g. ['a1b2c3d4-…'].",
      },
      body: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_NOTIFICATION_BODY,
        description:
          "What you need from them, in the requesting member's voice, e.g. 'Jaya asked if you could check the answer on the new-service question.'",
      },
    },
    required: ['recipient_ids', 'body'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const who = memberSurfaceOf(ctx, 'team_notify');
    if ('ok' in who) return who;

    const body = str(input.body).trim();
    if (!body) return { ok: false, error: 'body is required' };
    const recipientIds = strArr(input.recipient_ids).filter(Boolean);
    if (recipientIds.length === 0) {
      return {
        ok: false,
        error: 'recipient_ids is required — get ids from `team_member_list` first.',
      };
    }

    // Provenance from the authenticated surface, never the model — the same
    // discipline as team_request_create. This is what makes "notify her about
    // this" a link she can click.
    const surface = ctx.surface!;
    const topicId = surface.kind === 'forum' ? surface.topicId : null;
    const postId = surface.kind === 'forum' ? (surface.inboundPostId ?? null) : null;

    try {
      const res = await notifyMembers(ctx.ownerId, {
        recipientIds,
        senderId: who.contactId,
        senderName: who.contactName ?? null,
        body,
        topicId,
        postId,
      });
      ctx.step?.setMeta({ delivered: res.delivered.length, rejected: res.rejected.length });
      if (res.delivered.length === 0) {
        return {
          ok: false,
          error:
            'nobody was notified — none of those ids is a live team member of this brain. Re-run `team_member_list` and match the name again.',
        };
      }
      return {
        ok: true,
        output: {
          notified: res.delivered.length,
          recipient_ids: res.delivered.map((d) => d.recipientId),
          // Surfaced so the responder can tell the member who it could NOT
          // reach — silently dropping a recipient reads as "done" and the
          // colleague is never told.
          not_notified: res.rejected,
          ...(topicId ? { linked_topic: topicId } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const team_chat_list: BuiltinToolDef = {
  slug: 'team_chat_list',
  readOnly: true,
  name: 'List team chat members',
  description:
    "List the brain's team members and their Team Chat activity: last message, thread size, membership since, token last used. Use for questions like 'who has been using team chat' or as the index before `team_chat_read`.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    if (ctx.surface?.kind === 'team' || ctx.surface?.kind === 'forum') {
      return { ok: false, error: 'owner-side tool — not available on the team surfaces' };
    }
    const members = await listTeamMemberActivity(ctx.ownerId);
    ctx.step?.setMeta({ count: members.length });
    return { ok: true, output: { members, count: members.length } };
  },
};

const team_chat_read: BuiltinToolDef = {
  slug: 'team_chat_read',
  readOnly: true,
  preconditions: TEAM_CONTACT_ID_PRE,
  name: 'Read a team chat thread',
  description:
    "Read a window of one team member's Team Chat thread (ascending; newest window by default, `before` pages older). `contactId` comes from `team_chat_list` or `contact_find`. Use to answer 'what has <member> asked about'.",
  inputSchema: {
    type: 'object',
    properties: {
      contactId: {
        type: 'string',
        description: "The member's contact id, from `team_chat_list` or `contact_find`.",
      },
      before: {
        type: 'string',
        description: 'ISO timestamp cursor — return messages older than this.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Max messages to return.',
      },
    },
    required: ['contactId'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    if (ctx.surface?.kind === 'team' || ctx.surface?.kind === 'forum') {
      return { ok: false, error: 'owner-side tool — not available on the team surfaces' };
    }
    const contactId = str(input.contactId);
    if (!contactId) return { ok: false, error: 'contactId required' };
    const messages = await listTeamThread(ctx.ownerId, contactId, {
      before: strOpt(input.before),
      limit: numOpt(input.limit) ?? 50,
    });
    ctx.step?.setMeta({ contactId, count: messages.length });
    return {
      ok: true,
      output: {
        messages: messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          text: m.text,
          channel: m.channel,
          traceId: m.traceId,
          createdAt: m.createdAt.toISOString(),
        })),
        count: messages.length,
      },
    };
  },
};

const team_access_list: BuiltinToolDef = {
  slug: 'team_access_list',
  readOnly: true,
  preconditions: TEAM_CONTACT_ID_PRE,
  name: 'List team access log',
  description:
    'The Team Chat audit trail, newest first: token auths, turns, API calls, denied attempts — each with the contact and detail. Optional `contactId` narrows to one member.',
  inputSchema: {
    type: 'object',
    properties: {
      contactId: {
        type: 'string',
        description:
          'Narrow the log to one member — a contact id from `team_chat_list` or `contact_find`.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 100,
        description: 'Max entries to return.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    if (ctx.surface?.kind === 'team' || ctx.surface?.kind === 'forum') {
      return { ok: false, error: 'owner-side tool — not available on the team surfaces' };
    }
    const rows = await listTeamAccess(ctx.ownerId, {
      contactId: strOpt(input.contactId),
      limit: numOpt(input.limit) ?? 100,
    });
    ctx.step?.setMeta({ count: rows.length });
    return { ok: true, output: { entries: rows, count: rows.length } };
  },
};

export const TEAM_TOOLS: BuiltinToolDef[] = [
  team_request_create,
  team_member_list,
  team_notify,
  team_chat_list,
  team_chat_read,
  team_access_list,
];
