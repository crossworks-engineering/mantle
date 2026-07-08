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
 * `team_chat_list` / `team_chat_read` / `team_access_list` — OWNER-side admin
 * tools (granted via the `team-admin` group to the persona, never to the team
 * responder). They make team activity queryable by the brain: "what has Rea
 * asked about this week?".
 */

import {
  createTask,
  listTeamAccess,
  listTeamMemberActivity,
  listTeamThread,
  nodeUrl,
  type TaskPriority,
} from '@mantle/content';
import type { ToolPrecondition, BuiltinToolDef, ToolHandlerResult } from './types';

const TEAM_CONTACT_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'contactId', nodeType: 'contact', lookup: 'team_chat_list / contact_find' },
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
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
        description: "Short imperative summary of the requested change, e.g. 'Update RBI report 30257 with revised inspection dates'.",
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
    if (ctx.surface?.kind !== 'team') {
      return {
        ok: false,
        error:
          'team_request_create only runs on the Team Chat surface — the requesting team member must be the one asking.',
      };
    }
    const title = str(input.title).trim();
    const body = str(input.body).trim();
    if (!title || !body) return { ok: false, error: 'title and body required' };

    // Provenance comes from the authenticated surface context, not the model.
    const { contactId, contactName, inboundMessageId } = ctx.surface;
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

const team_chat_list: BuiltinToolDef = {
  slug: 'team_chat_list',
  name: 'List team chat members',
  description:
    "List the brain's team members and their Team Chat activity: last message, thread size, membership since, token last used. Use for questions like 'who has been using team chat' or as the index before `team_chat_read`.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    if (ctx.surface?.kind === 'team') {
      return { ok: false, error: 'owner-side tool — not available on the Team Chat surface' };
    }
    const members = await listTeamMemberActivity(ctx.ownerId);
    ctx.step?.setMeta({ count: members.length });
    return { ok: true, output: { members, count: members.length } };
  },
};

const team_chat_read: BuiltinToolDef = {
  slug: 'team_chat_read',
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
      before: { type: 'string', description: 'ISO timestamp cursor — return messages older than this.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Max messages to return.' },
    },
    required: ['contactId'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    if (ctx.surface?.kind === 'team') {
      return { ok: false, error: 'owner-side tool — not available on the Team Chat surface' };
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
  preconditions: TEAM_CONTACT_ID_PRE,
  name: 'List team access log',
  description:
    'The Team Chat audit trail, newest first: token auths, turns, API calls, denied attempts — each with the contact and detail. Optional `contactId` narrows to one member.',
  inputSchema: {
    type: 'object',
    properties: {
      contactId: {
        type: 'string',
        description: "Narrow the log to one member — a contact id from `team_chat_list` or `contact_find`.",
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Max entries to return.' },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    if (ctx.surface?.kind === 'team') {
      return { ok: false, error: 'owner-side tool — not available on the Team Chat surface' };
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
  team_chat_list,
  team_chat_read,
  team_access_list,
];
