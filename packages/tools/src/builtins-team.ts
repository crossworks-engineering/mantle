/**
 * Team tools.
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
 * responder). They make team activity queryable by the brain: "what has Sam
 * asked about this week?". Users are the team: the chats they read are member
 * LOGIN threads; the retired team-code portal threads stay readable as
 * history by contact id, and a login invited from a contact gets its
 * contact's portal thread with its own, labelled apart (never merged).
 */

import {
  createTask,
  listTeamAccess,
  listLoginPortalThread,
  listMemberChatActivity,
  listTeamMemberActivity,
  listTeamThread,
  nodeUrl,
  type TaskPriority,
} from '@mantle/content';
import type { ToolPrecondition, BuiltinToolDef, ToolHandlerResult } from './types';
import { str, strOpt, numOpt } from './coerce';
import { errorMessage, UUID_RE } from '@mantle/std';
import { asSystem } from '@mantle/db/viewer';

const TEAM_CONTACT_ID_PRE: readonly ToolPrecondition[] = [
  {
    kind: 'node_exists',
    param: 'contactId',
    nodeType: 'contact',
    lookup: 'team_chat_list / contact_find',
  },
];

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
    if (surface?.kind !== 'team') {
      return {
        ok: false,
        error:
          'team_request_create only runs on the team surface: the requesting team member must be the one asking.',
      };
    }
    const title = str(input.title).trim();
    const body = str(input.body).trim();
    if (!title || !body) return { ok: false, error: 'title and body required' };

    // Provenance comes from the authenticated surface context, not the model.
    const { contactId, contactName, loginId, inboundMessageId } = surface;
    let attachments: { nodeId: string }[] = [];
    if (inboundMessageId) {
      // A member login's thread is read by login; a portal thread by contact.
      const [msg] = await listTeamThread(ctx.ownerId, contactId ?? '', {
        limit: 200,
        ...(loginId ? { loginId } : {}),
      }).then((rows) => [rows.find((r) => r.id === inboundMessageId)]);
      attachments = (msg?.attachments ?? [])
        .filter((a) => typeof a.nodeId === 'string' && a.nodeId.length > 0)
        .map((a) => ({ nodeId: a.nodeId! }));
    }

    try {
      const requester = contactName ? `${contactName}` : 'a team member';
      const attachmentLines = attachments.length
        ? `\n\n**Attachments:**\n${attachments.map((a) => `- [attached file](${nodeUrl(a.nodeId)})`).join('\n')}`
        : '';
      // asSystem: a team turn runs on the limited team role, which never
      // writes; the request is an admin-level task filed on the member's
      // behalf with server-stamped provenance (the one audited escape).
      const row = await asSystem(() =>
        createTask(ctx.ownerId, {
          title,
          body: `**Team request from ${requester}.**\n\n${body}${attachmentLines}`,
          priority: (strOpt(input.priority) as TaskPriority | undefined) ?? 'normal',
          tags: [TEAM_REQUEST_TAG],
          extraData: {
            teamRequest: {
              contactId: contactId ?? null,
              loginId: loginId ?? null,
              contactName: contactName ?? null,
              threadMessageId: inboundMessageId ?? null,
              attachments: attachments.map((a) => a.nodeId),
              filedAt: new Date().toISOString(),
            },
          },
        }),
      );
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

const team_chat_list: BuiltinToolDef = {
  slug: 'team_chat_list',
  readOnly: true,
  name: 'List team chat members',
  description:
    "List the brain's member logins (the team) and their chat activity: last message, thread size, whether the login is still active. Use for questions like 'who has been chatting with the team agent' or as the index before `team_chat_read`. The portal_archive field lists old team-code portal threads (history only; read them by `contactId`).",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx): Promise<ToolHandlerResult> => {
    if (ctx.surface?.kind === 'team') {
      return { ok: false, error: 'owner-side tool: not available on the team surface' };
    }
    const [members, portal] = await Promise.all([
      listMemberChatActivity(ctx.ownerId),
      listTeamMemberActivity(ctx.ownerId),
    ]);
    const portal_archive = portal
      .filter((p) => p.messageCount > 0)
      .map((p) => ({
        contactId: p.contactId,
        contactName: p.contactName,
        messageCount: p.messageCount,
        lastMessageAt: p.lastMessageAt,
      }));
    ctx.step?.setMeta({ count: members.length, archive: portal_archive.length });
    return {
      ok: true,
      output: {
        members,
        count: members.length,
        ...(portal_archive.length ? { portal_archive } : {}),
      },
    };
  },
};

/** One thread row as the owner-side tools return it. */
function chatLine(m: {
  id: string;
  direction: string;
  text: string;
  channel: string;
  traceId: string | null;
  createdAt: Date;
}) {
  return {
    id: m.id,
    direction: m.direction,
    text: m.text,
    channel: m.channel,
    traceId: m.traceId,
    createdAt: m.createdAt.toISOString(),
  };
}

const team_chat_read: BuiltinToolDef = {
  slug: 'team_chat_read',
  readOnly: true,
  preconditions: TEAM_CONTACT_ID_PRE,
  name: 'Read a team chat thread',
  description:
    "Read a window of one team member's chat thread (ascending; newest window by default, `before` pages older). Pass `loginId` (from `team_chat_list`) for a member login's thread, or `contactId` for an old team-code portal thread (history). With `loginId` and no `before`, a login invited from a team contact also returns `portal_history`: that contact's OLD portal chat, a separate thread from `messages` (page it with its `contactId` and `before`). Use to answer 'what has <member> asked about'.",
  inputSchema: {
    type: 'object',
    properties: {
      loginId: {
        type: 'string',
        description: "The member login's id, from `team_chat_list`.",
      },
      contactId: {
        type: 'string',
        description:
          'A contact id from the portal_archive field of `team_chat_list`: reads that old team-code portal thread.',
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
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    if (ctx.surface?.kind === 'team') {
      return { ok: false, error: 'owner-side tool: not available on the team surface' };
    }
    const loginId = strOpt(input.loginId);
    const contactId = strOpt(input.contactId);
    if (!loginId && !contactId) {
      return { ok: false, error: 'loginId (or contactId for a portal thread) required' };
    }
    if (loginId && !UUID_RE.test(loginId)) {
      return { ok: false, error: 'loginId must be a login id from `team_chat_list`' };
    }
    const before = strOpt(input.before);
    const limit = numOpt(input.limit) ?? 50;
    const messages = await listTeamThread(ctx.ownerId, contactId ?? '', {
      before,
      limit,
      ...(loginId ? { loginId } : {}),
    });
    // The login's old portal chat (its contact's, from before the invite):
    // on the first window only, and apart from `messages`, never merged.
    const portal =
      loginId && !before ? await listLoginPortalThread(ctx.ownerId, loginId, { limit }) : null;
    const portal_history =
      portal && portal.messages.length > 0
        ? {
            note: "The member's OLD team-code portal chat, from before they had a login. History only: a separate thread, not part of their current chat.",
            contactId: portal.contactId,
            messages: portal.messages.map(chatLine),
            count: portal.messages.length,
          }
        : null;
    ctx.step?.setMeta({
      ...(loginId ? { loginId } : { contactId }),
      count: messages.length,
      ...(portal_history ? { portal: portal_history.count } : {}),
    });
    return {
      ok: true,
      output: {
        messages: messages.map(chatLine),
        count: messages.length,
        ...(portal_history ? { portal_history } : {}),
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
    'The Team Chat audit trail, newest first: token auths, turns, API calls, denied attempts, each with the contact, the member login (`loginId`) and detail. Optional `loginId` narrows to one member login (its own events and the portal history of the contact it was invited from); optional `contactId` narrows to one team contact.',
  inputSchema: {
    type: 'object',
    properties: {
      loginId: {
        type: 'string',
        description: 'Narrow the log to one member login, an id from `team_chat_list`.',
      },
      contactId: {
        type: 'string',
        description:
          'Narrow the log to one team contact, an id from `team_chat_list` (portal_archive) or `contact_find`.',
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
    if (ctx.surface?.kind === 'team') {
      return { ok: false, error: 'owner-side tool: not available on the team surface' };
    }
    const loginId = strOpt(input.loginId);
    if (loginId && !UUID_RE.test(loginId)) {
      return { ok: false, error: 'loginId must be a login id from `team_chat_list`' };
    }
    const rows = await listTeamAccess(ctx.ownerId, {
      contactId: strOpt(input.contactId),
      ...(loginId ? { loginId } : {}),
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
