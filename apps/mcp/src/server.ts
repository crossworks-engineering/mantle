/**
 * Mantle MCP server.
 *
 * Exposes the user's tree, emails, files, telegram messages, secrets, and
 * content surfaces to Claude over MCP. Stdio only — Claude Desktop or
 * Claude Code spawn this process and talk to it over JSON-RPC.
 *
 * Threat model: stdio means anyone who can spawn this process inherits
 * the owner's full data access. That's fine on your laptop and on a
 * personal VPS where you're the only shell user. **Do not** expose this
 * as a network service without a real auth layer; an HTTP transport is
 * intentionally not wired here so it can't be enabled by accident.
 *
 * Owner is scoped by ALLOWED_USER_ID; at startup we verify the value is
 * a real UUID AND that the row exists in auth.users — typoing the env
 * to a stranger's UUID would otherwise silently surface their data.
 *
 * Env loading is handled by Node's `--env-file-if-exists=.env.local` in
 * the package script; this entry just trusts `process.env`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  db,
  agents,
  emails,
  nodes,
  telegramAccounts,
  telegramChats,
  telegramMessages,
} from '@mantle/db';
import {
  entityFacts,
  entityMentions,
  entityNeighbors,
  searchEntities,
  searchNodes,
  searchChunks,
} from '@mantle/search';
import { embed } from '@mantle/embeddings';
import {
  accountForChat,
  editMessage,
  reactToMessage,
  sendMessage,
} from '@mantle/telegram';
import {
  createFolder,
  deleteFileById,
  deleteFolder,
  ensureFilesRootBranch,
  fileById,
  folderByPath,
  listAllFolders,
  listFiles,
  listFolders,
  readFileById,
  updateFolderDescription,
  upsertFile,
  MAX_UPLOAD_BYTES,
} from '@mantle/files';
import {
  approvePendingCall,
  getPendingCall,
  listPendingCalls,
  rejectPendingCall,
} from '@mantle/tools';
import { authUsers } from '@mantle/db';
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  createEvent,
  createNote,
  createTodo,
  deleteEvent,
  deleteNote,
  deleteTodo,
  getEvent,
  getNote,
  getPage,
  getTodo,
  listEvents,
  listNotes,
  listPages,
  listTodos,
  updateEvent,
  updateNote,
  updateTodo,
} from '@mantle/content';
import { and, asc, desc, eq } from 'drizzle-orm';

const OWNER_ID = process.env.ALLOWED_USER_ID;
if (!OWNER_ID) {
  console.error('[mantle-mcp] ALLOWED_USER_ID must be set so the MCP server knows whose tree to expose.');
  process.exit(1);
}

// Lightweight UUID syntax guard. Catches typos like trailing whitespace
// or extra characters in .env that would otherwise sneak past Drizzle's
// stringly-typed eq() and silently match nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(OWNER_ID)) {
  console.error(
    `[mantle-mcp] ALLOWED_USER_ID '${OWNER_ID}' is not a valid UUID. Refusing to start.`,
  );
  process.exit(1);
}

// Verify the user actually exists. Without this, a typo in
// ALLOWED_USER_ID would not error — it'd just scope every query to
// "user not found", returning empty results and accepting writes that
// no longer belong to any real owner. Cheap to check once at boot.
{
  const [existing] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, OWNER_ID))
    .limit(1);
  if (!existing) {
    console.error(
      `[mantle-mcp] ALLOWED_USER_ID ${OWNER_ID} does not match any auth.users row. ` +
        `Run the web UI signup or update .env.local.`,
    );
    process.exit(1);
  }
}

const server = new McpServer({ name: 'mantle', version: '0.0.1' });

server.tool(
  'tree_list',
  'List children of a branch in the Mantle tree. Pass no path for top-level branches.',
  { path: z.string().optional() },
  async ({ path }) => {
    const rows = await db
      .select({ id: nodes.id, title: nodes.title, type: nodes.type, path: nodes.path })
      .from(nodes)
      .where(
        and(eq(nodes.ownerId, OWNER_ID!), path ? (eq as any)(nodes.path, path) : eq(nodes.type, 'branch')),
      )
      .limit(200);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'search',
  "Hybrid full-text + tree search over Jason's Mantle. Use `branch` (ltree path) to scope, `type` to filter.",
  {
    q: z.string().optional(),
    branch: z.string().optional(),
    type: z
      .enum([
        'branch',
        'email',
        'email_thread',
        'file',
        'note',
        'page',
        'sermon',
        'contact',
        'secret',
        'task',
        'event',
        'printer_project',
        'telegram_message',
      ])
      .optional(),
    tags: z.array(z.string()).optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ q, branch, type, tags, since, limit }) => {
    const results = await searchNodes({
      ownerId: OWNER_ID!,
      q,
      branch,
      type,
      tags,
      since: since ? new Date(since) : undefined,
      limit,
    });
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

server.tool(
  'search_chunks',
  "Semantic (vector) search over document passages — finds the most relevant *sections* inside pages, files, emails, notes (not just whole-node keyword hits). Use when `search` misses or you want the specific passage. `branch` scopes by ltree path (e.g. 'pages').",
  {
    q: z.string(),
    branch: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ q, branch, limit }) => {
    const embedding = await embed(OWNER_ID!, q);
    const hits = await searchChunks({ ownerId: OWNER_ID!, embedding, branch, limit: limit ?? 10 });
    return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
  },
);

server.tool(
  'email_get',
  'Fetch a single email by id (body, headers, attachment refs).',
  { id: z.string().uuid() },
  async ({ id }) => {
    const [row] = await db.select().from(emails).where(eq(emails.id, id)).limit(1);
    if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'email_list',
  "Recent emails newest-first. Optionally filter by `accountId` or `since`.",
  {
    accountId: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ accountId, since, limit }) => {
    const conds: any[] = [];
    if (accountId) conds.push(eq(emails.accountId, accountId));
    if (since) conds.push((eq as any)(emails.internalDate, new Date(since))); // placeholder until gte helper imported
    const rows = await db
      .select()
      .from(emails)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(emails.internalDate))
      .limit(limit ?? 50);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

// ─── files / folders ──────────────────────────────────────────────────────

server.tool(
  'folder_list',
  "List folders in Jason's host-mirrored filesystem. Pass `parent` (ltree path, e.g. 'files.work') to list immediate children of that folder; pass `tree: true` to get every folder in the subtree at once. With no args, returns the immediate children of the root.",
  {
    parent: z.string().optional(),
    tree: z.boolean().optional(),
  },
  async ({ parent, tree }) => {
    await ensureFilesRootBranch(OWNER_ID!);
    if (tree) {
      const all = await listAllFolders(OWNER_ID!);
      return { content: [{ type: 'text', text: JSON.stringify(all, null, 2) }] };
    }
    const rows = await listFolders({ ownerId: OWNER_ID!, parentPath: parent ?? 'files' });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'folder_create',
  "Create a folder under `parent_path` (ltree, e.g. 'files.work'). Slug must be lowercase + dashes — anything else gets normalised. Description is optional but recommended so future agents know what the folder is for. Creates the directory on disk and the DB row in lockstep.",
  {
    parent_path: z.string().min(1).max(500),
    slug: z.string().min(1).max(64),
    description: z.string().max(2000).optional(),
  },
  async ({ parent_path, slug, description }) => {
    await ensureFilesRootBranch(OWNER_ID!);
    try {
      const folder = await createFolder({
        ownerId: OWNER_ID!,
        parentPath: parent_path,
        slug,
        description,
      });
      return { content: [{ type: 'text', text: JSON.stringify(folder, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `folder_create failed: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'folder_describe',
  "Set or clear a folder's description. Useful for agents that just created a folder and want to document what goes in it.",
  {
    folder_id: z.string().uuid().optional(),
    path: z.string().optional(),
    description: z.string().max(2000),
  },
  async ({ folder_id, path, description }) => {
    let id = folder_id ?? null;
    if (!id && path) {
      const found = await folderByPath({ ownerId: OWNER_ID!, path });
      id = found?.id ?? null;
    }
    if (!id) {
      return { content: [{ type: 'text', text: 'folder_describe: pass folder_id or path' }], isError: true };
    }
    const updated = await updateFolderDescription({
      ownerId: OWNER_ID!,
      folderId: id,
      description,
    });
    if (!updated) {
      return { content: [{ type: 'text', text: 'folder not found' }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
  },
);

server.tool(
  'folder_delete',
  "Delete a folder. Refuses unless the folder is empty — clear its children first. Cannot delete the `files` root.",
  { folder_id: z.string().uuid() },
  async ({ folder_id }) => {
    const res = await deleteFolder({ ownerId: OWNER_ID!, folderId: folder_id });
    if (!res.ok) {
      return { content: [{ type: 'text', text: `folder_delete: ${res.reason}` }], isError: true };
    }
    return { content: [{ type: 'text', text: 'deleted' }] };
  },
);

server.tool(
  'file_list',
  "List files in a folder. `parent_path` is the ltree path of the containing folder (e.g. 'files.work.lister-printer').",
  {
    parent_path: z.string().min(1).max(500),
  },
  async ({ parent_path }) => {
    const rows = await listFiles({ ownerId: OWNER_ID!, parentPath: parent_path });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'file_upload',
  "Create or overwrite a file in a folder. Pass either `content_text` (utf-8) or `content_base64` (binary). Filename is lowercased + sanitised. The extractor agent will pick up text files (md/txt/json/yaml) automatically via pg_notify('node_ingested').",
  {
    parent_path: z.string().min(1).max(500),
    filename: z.string().min(1).max(200),
    content_text: z.string().optional(),
    content_base64: z.string().optional(),
    overwrite: z.boolean().optional(),
  },
  async ({ parent_path, filename, content_text, content_base64, overwrite }) => {
    if (content_text == null && content_base64 == null) {
      return {
        content: [{ type: 'text', text: 'file_upload: pass content_text or content_base64' }],
        isError: true,
      };
    }
    const bytes = content_text != null
      ? Buffer.from(content_text, 'utf8')
      : Buffer.from(content_base64!, 'base64');
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return {
        content: [
          {
            type: 'text',
            text: `file_upload: too large (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB > ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`,
          },
        ],
        isError: true,
      };
    }
    try {
      const row = await upsertFile({
        ownerId: OWNER_ID!,
        parentPath: parent_path,
        filename,
        bytes,
        overwrite,
      });
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `file_upload failed: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'file_read',
  "Read a file by id. For text files returns the content as a utf-8 string; for binaries returns base64-encoded bytes (only call this on small files).",
  { file_id: z.string().uuid() },
  async ({ file_id }) => {
    const res = await readFileById({ ownerId: OWNER_ID!, fileId: file_id });
    if (!res) {
      return { content: [{ type: 'text', text: 'file not found' }], isError: true };
    }
    const isText = res.row.isText;
    const out = {
      file: res.row,
      ...(isText
        ? { content_text: res.bytes.toString('utf8') }
        : { content_base64: res.bytes.toString('base64') }),
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
);

server.tool(
  'file_get',
  "Fetch a file's metadata by id without loading bytes. Useful for resolving a uuid surfaced by search before deciding what to do with it.",
  { file_id: z.string().uuid() },
  async ({ file_id }) => {
    const row = await fileById({ ownerId: OWNER_ID!, fileId: file_id });
    if (!row) {
      return { content: [{ type: 'text', text: 'file not found' }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'file_delete',
  'Delete a file by id. Removes both the DB row and the on-disk file.',
  { file_id: z.string().uuid() },
  async ({ file_id }) => {
    const res = await deleteFileById({ ownerId: OWNER_ID!, fileId: file_id });
    if (!res.ok) {
      return { content: [{ type: 'text', text: 'file not found' }], isError: true };
    }
    return { content: [{ type: 'text', text: 'deleted' }] };
  },
);

// ─── pending tool calls (operator approvals) ─────────────────────────────

server.tool(
  'pending_list',
  "List operator-approval-required tool calls an agent has queued. By default returns the still-pending queue; pass `status` ('pending'|'approved'|'rejected'|'expired') to filter, and `limit` to cap.",
  {
    status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async ({ status, limit }) => {
    const rows = await listPendingCalls(OWNER_ID!, { status: status ?? 'pending', limit });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'pending_approve',
  "Approve a queued tool call by id. The handler runs immediately under a fresh `manual` trace; the result is stored on the pending row and returned.",
  { id: z.string().uuid() },
  async ({ id }) => {
    const row = await approvePendingCall(OWNER_ID!, id);
    if (!row) {
      return { content: [{ type: 'text', text: 'not found or already decided' }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'pending_reject',
  "Reject a queued tool call by id. No execution; just flips status to 'rejected'.",
  { id: z.string().uuid() },
  async ({ id }) => {
    const row = await rejectPendingCall(OWNER_ID!, id);
    if (!row) {
      return { content: [{ type: 'text', text: 'not found or already decided' }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'pending_get',
  'Fetch a pending tool call by id — useful to inspect the args before deciding.',
  { id: z.string().uuid() },
  async ({ id }) => {
    const row = await getPendingCall(OWNER_ID!, id);
    if (!row) {
      return { content: [{ type: 'text', text: 'not found' }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

// ─── entities ─────────────────────────────────────────────────────────────

server.tool(
  'entity_search',
  "Resolve a name or alias to entities in Jason's memory. Exact name/alias matches return similarity=1; otherwise trigram fuzzy match. Optional `kind` filter (person, project, place, org, event, ...).",
  {
    q: z.string().min(1),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ q, kind, limit }) => {
    const hits = await searchEntities({ ownerId: OWNER_ID!, q, kind, limit });
    return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
  },
);

server.tool(
  'entity_neighbors',
  "Walk the entity graph one hop from a given entity. Returns connected entities via entity_edges in both directions by default. Optional `relation` filter (e.g. 'married_to', 'works_at', 'mentioned_in'), `direction` ('in'|'out'|'both'), and `current_only` to drop edges with valid_to set.",
  {
    entity_id: z.string().uuid(),
    relation: z.string().optional(),
    direction: z.enum(['in', 'out', 'both']).optional(),
    current_only: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ entity_id, relation, direction, current_only, limit }) => {
    const rows = await entityNeighbors({
      ownerId: OWNER_ID!,
      entityId: entity_id,
      relation,
      direction,
      currentOnly: current_only,
      limit,
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'entity_facts',
  "All facts attached to an entity. By default returns currently-valid facts only; set `include_retired=true` to see superseded history too. Use after entity_search to get '\"what do I know about Sarah?\"' answers.",
  {
    entity_id: z.string().uuid(),
    include_retired: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ entity_id, include_retired, limit }) => {
    const rows = await entityFacts({
      ownerId: OWNER_ID!,
      entityId: entity_id,
      includeRetired: include_retired,
      limit,
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'entity_mentions',
  'Content_store nodes that mention this entity, newest first. Walks entity_edges where source_kind=entity, target_kind=node, relation=mentioned_in. Returns node id, title, type, and the per-node summary if the extractor has populated one.',
  {
    entity_id: z.string().uuid(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ entity_id, limit }) => {
    const rows = await entityMentions({ ownerId: OWNER_ID!, entityId: entity_id, limit });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

// ─── telegram ─────────────────────────────────────────────────────────────

server.tool(
  'telegram_pending',
  'Unanswered Telegram DMs, oldest first. Call after each turn (or via /loop) to see what needs a reply. Returns the row id (for mark_processed), telegram_message_id (for reply threading), chat_id, sender, text, and sent_at.',
  {
    chat_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ chat_id, limit }) => {
    const conds = [eq(telegramMessages.processed, false)];
    if (chat_id) {
      // chat_id is the *Telegram* chat id; resolve to our internal pk first.
      const [chat] = await db
        .select({ id: telegramChats.id })
        .from(telegramChats)
        .where(eq(telegramChats.telegramChatId, chat_id))
        .limit(1);
      if (!chat) return { content: [{ type: 'text', text: '[]' }] };
      conds.push(eq(telegramMessages.chatId, chat.id));
    }
    const rows = await db
      .select({
        id: telegramMessages.id,
        telegram_message_id: telegramMessages.telegramMessageId,
        chat_id: telegramChats.telegramChatId,
        from_user_id: telegramMessages.fromUserId,
        from_username: telegramMessages.fromUsername,
        from_name: telegramMessages.fromName,
        text: telegramMessages.text,
        sent_at: telegramMessages.sentAt,
        attachments: telegramMessages.attachments,
      })
      .from(telegramMessages)
      .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
      .where(and(...conds))
      .orderBy(asc(telegramMessages.sentAt))
      .limit(limit ?? 20);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'telegram_send',
  'Send a Telegram message to a chat. Pass chat_id from a telegram_pending row. Optionally pass reply_to (telegram_message_id) for threading. Long text is split into 4096-char chunks.',
  {
    chat_id: z.string(),
    text: z.string().min(1),
    reply_to: z.string().optional(),
    markdown: z.boolean().optional(),
  },
  async ({ chat_id, text, reply_to, markdown }) => {
    const account = await accountForChat(chat_id);
    if (!account) {
      return { content: [{ type: 'text', text: 'no enabled telegram account' }], isError: true };
    }
    // Outbound gate: only send to chats we already know (i.e. they DM'd us
    // and were allowlisted). Prevents Claude from spamming arbitrary chat
    // ids on its own initiative.
    const [chat] = await db
      .select()
      .from(telegramChats)
      .where(
        and(
          eq(telegramChats.accountId, account.id),
          eq(telegramChats.telegramChatId, chat_id),
        ),
      )
      .limit(1);
    if (!chat || chat.allowlistStatus !== 'allowed') {
      return {
        content: [{ type: 'text', text: `chat ${chat_id} is not allowlisted` }],
        isError: true,
      };
    }
    try {
      const ids = await sendMessage(account, chat_id, text, {
        replyTo: reply_to,
        markdown,
      });
      return {
        content: [
          {
            type: 'text',
            text:
              ids.length === 1
                ? `sent (id: ${ids[0]})`
                : `sent ${ids.length} parts (ids: ${ids.join(', ')})`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `send failed: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'telegram_react',
  'Add an emoji reaction to a Telegram message. Telegram accepts only a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc).',
  {
    chat_id: z.string(),
    message_id: z.string(),
    emoji: z.string(),
  },
  async ({ chat_id, message_id, emoji }) => {
    const account = await accountForChat(chat_id);
    if (!account) {
      return { content: [{ type: 'text', text: 'no enabled telegram account' }], isError: true };
    }
    try {
      await reactToMessage(account, chat_id, message_id, emoji);
      return { content: [{ type: 'text', text: 'reacted' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `react failed: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'telegram_edit',
  'Edit a previously-sent Telegram message in place. Useful for progress updates. Edits do not trigger push notifications — send a new reply when a long task completes.',
  {
    chat_id: z.string(),
    message_id: z.string(),
    text: z.string().min(1),
    markdown: z.boolean().optional(),
  },
  async ({ chat_id, message_id, text, markdown }) => {
    const account = await accountForChat(chat_id);
    if (!account) {
      return { content: [{ type: 'text', text: 'no enabled telegram account' }], isError: true };
    }
    try {
      await editMessage(account, chat_id, message_id, text, { markdown });
      return { content: [{ type: 'text', text: 'edited' }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `edit failed: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  'telegram_mark_processed',
  'Mark a telegram message as answered so it stops appearing in telegram_pending. Pass the row id from telegram_pending.',
  { id: z.string().uuid() },
  async ({ id }) => {
    const rows = await db
      .update(telegramMessages)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(telegramMessages.id, id))
      .returning({ id: telegramMessages.id });
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'no such message' }], isError: true };
    }
    return { content: [{ type: 'text', text: 'marked processed' }] };
  },
);

server.tool(
  'telegram_pair',
  'Approve a pending Telegram pairing code. The chat gets allowlisted and a confirmation DM is sent.',
  { code: z.string().regex(/^[a-f0-9]{6}$/i) },
  async ({ code }) => {
    const [chat] = await db
      .select()
      .from(telegramChats)
      .where(and(eq(telegramChats.pairingCode, code), eq(telegramChats.userId, OWNER_ID!)))
      .limit(1);
    if (!chat) {
      return { content: [{ type: 'text', text: 'no pending pairing with that code' }], isError: true };
    }
    if (chat.allowlistStatus === 'allowed') {
      return { content: [{ type: 'text', text: 'already paired' }] };
    }
    if (chat.pairingExpiresAt && chat.pairingExpiresAt.getTime() < Date.now()) {
      return { content: [{ type: 'text', text: 'code expired — ask them to DM again' }], isError: true };
    }
    await db
      .update(telegramChats)
      .set({
        allowlistStatus: 'allowed',
        pairingCode: null,
        pairingExpiresAt: null,
        pairingReplies: 0,
        updatedAt: new Date(),
      })
      .where(eq(telegramChats.id, chat.id));

    const [account] = await db
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.id, chat.accountId))
      .limit(1);
    if (account) {
      let name = 'your assistant';
      if (account.responderAgentId) {
        const [agentRow] = await db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, account.responderAgentId))
          .limit(1);
        if (agentRow?.name) name = agentRow.name;
      }
      try {
        await sendMessage(account, chat.telegramChatId, `Paired! Say hi to ${name}.`);
      } catch (err) {
        // The chat is paired in the DB; the confirmation DM is best-effort.
        console.error('[mantle-mcp] pair confirm DM failed:', err);
      }
    }
    return {
      content: [
        { type: 'text', text: `paired chat ${chat.telegramChatId} (${chat.title ?? chat.username ?? 'unnamed'})` },
      ],
    };
  },
);

// ─── Notes / Todos / Events ────────────────────────────────────────────────
//
// Three content surfaces the assistant can drive. All three are jsonb on
// `nodes` (no dedicated tables) and all three flow through the extractor
// for summary + embedding, so semantic search ("what notes do I have
// about X?") works without explicit indexing here.

server.tool(
  'note_list',
  'List the owner\'s notes. Optional `query` does a substring match against title/body/summary; `tag` filters to notes carrying that tag.',
  {
    query: z.string().optional(),
    tag: z.string().optional(),
  },
  async ({ query, tag }) => {
    const rows = await listNotes(OWNER_ID!, { query, tag });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'note_get',
  'Get a single note by id, including its full markdown content.',
  { id: z.string() },
  async ({ id }) => {
    const row = await getNote(OWNER_ID!, id);
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'note_create',
  'Create a note. Title is required; content is markdown.',
  {
    title: z.string().min(1).max(200),
    content: z.string().max(500_000).optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ title, content, tags }) => {
    const row = await createNote(OWNER_ID!, {
      title,
      content: content ?? '',
      tags: tags ?? [],
    });
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'note_update',
  'Update a note. Pass only the fields you want changed.',
  {
    id: z.string(),
    title: z.string().min(1).max(200).optional(),
    content: z.string().max(500_000).optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ id, title, content, tags }) => {
    const row = await updateNote(OWNER_ID!, id, { title, content, tags });
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'note_delete',
  'Delete a note by id.',
  { id: z.string() },
  async ({ id }) => {
    const ok = await deleteNote(OWNER_ID!, id);
    return { content: [{ type: 'text', text: ok ? 'deleted' : 'not found' }] };
  },
);

// ─── Pages (read-only) ─────────────────────────────────────────────────────
//
// Rich TipTap documents (type='page'). Read-only over MCP for now — pages are
// authored in the web editor; the assistant finds and reads them. page_list
// omits the document body; page_get returns the full ProseMirror JSON.

server.tool(
  'page_list',
  "List the owner's pages. Optional `query` substring-matches title/body/summary; `tag` filters to pages carrying that tag. Bodies are omitted — use page_get for the full document.",
  {
    query: z.string().optional(),
    tag: z.string().optional(),
  },
  async ({ query, tag }) => {
    const rows = await listPages(OWNER_ID!, { query, tag });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'page_get',
  'Get a single page by id, including its full ProseMirror/TipTap document.',
  { id: z.string() },
  async ({ id }) => {
    const row = await getPage(OWNER_ID!, id);
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'todo_list',
  'List todos. `status` filters open/done; `priority` filters low/normal/high; `query` substring-matches title/body/summary. Default sort: open first, soonest due, then most-recently updated.',
  {
    query: z.string().optional(),
    status: z.enum([...TODO_STATUSES, 'all'] as ['open', 'done', 'all']).optional(),
    priority: z.enum([...TODO_PRIORITIES, 'all'] as ['low', 'normal', 'high', 'all']).optional(),
    tag: z.string().optional(),
  },
  async ({ query, status, priority, tag }) => {
    const rows = await listTodos(OWNER_ID!, {
      query,
      status: status ?? 'all',
      priority: priority ?? 'all',
      tag,
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'todo_get',
  'Get a single todo by id.',
  { id: z.string() },
  async ({ id }) => {
    const row = await getTodo(OWNER_ID!, id);
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'todo_create',
  'Create a todo. Title is required. `dueAt` is an ISO 8601 timestamp (e.g. "2026-05-25T17:00:00Z").',
  {
    title: z.string().min(1).max(200),
    body: z.string().max(50_000).optional(),
    status: z.enum(TODO_STATUSES).optional(),
    priority: z.enum(TODO_PRIORITIES).optional(),
    dueAt: z.string().datetime().nullable().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ title, body, status, priority, dueAt, tags }) => {
    const row = await createTodo(OWNER_ID!, {
      title,
      body,
      status,
      priority,
      dueAt,
      tags,
    });
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'todo_update',
  'Update a todo. Use this to flip status to "done", change priority, push the due date, etc.',
  {
    id: z.string(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(50_000).optional(),
    status: z.enum(TODO_STATUSES).optional(),
    priority: z.enum(TODO_PRIORITIES).optional(),
    dueAt: z.string().datetime().nullable().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ id, ...rest }) => {
    const row = await updateTodo(OWNER_ID!, id, rest);
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'todo_delete',
  'Delete a todo by id.',
  { id: z.string() },
  async ({ id }) => {
    const ok = await deleteTodo(OWNER_ID!, id);
    return { content: [{ type: 'text', text: ok ? 'deleted' : 'not found' }] };
  },
);

server.tool(
  'event_list',
  'List calendar events. `window` defaults to "upcoming"; use "past" or "all" to see history. `query` substring-matches title/body/location/summary.',
  {
    query: z.string().optional(),
    window: z.enum(['upcoming', 'past', 'all']).optional(),
    tag: z.string().optional(),
  },
  async ({ query, window, tag }) => {
    const rows = await listEvents(OWNER_ID!, { query, window, tag });
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  'event_get',
  'Get a single event by id.',
  { id: z.string() },
  async ({ id }) => {
    const row = await getEvent(OWNER_ID!, id);
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'event_create',
  'Create a calendar event. `startsAt` is an ISO 8601 instant. `remindMinutesBefore` controls when the Telegram reminder fires (0 = right at start). The reminder lands in the owner\'s most-recent allowed Telegram DM. `timezone` is an optional IANA tz (e.g. "Africa/Johannesburg") used to format the reminder message — the storage is always UTC. Set `recur` (daily/weekly/monthly/yearly) to repeat; `recurUntil` (ISO) caps the series.',
  {
    title: z.string().min(1).max(200),
    body: z.string().max(50_000).optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullable().optional(),
    location: z.string().max(200).nullable().optional(),
    remindMinutesBefore: z.number().int().min(0).max(60 * 24 * 30).optional(),
    timezone: z.string().max(64).optional(),
    recur: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
    recurUntil: z.string().datetime().nullable().optional(),
    tags: z.array(z.string()).optional(),
  },
  async (args) => {
    const row = await createEvent(OWNER_ID!, args);
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'event_update',
  'Update a calendar event. If you move `startsAt` or `remindMinutesBefore` and the new reminder time is still in the future, a previously-sent reminder will fire again. Pass `timezone` (IANA tz) to change how the reminder message formats the time. Set `recur` to change the repeat frequency (\'none\' stops it); `recurUntil` caps the series.',
  {
    id: z.string(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(50_000).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    location: z.string().max(200).nullable().optional(),
    remindMinutesBefore: z.number().int().min(0).max(60 * 24 * 30).optional(),
    timezone: z.string().max(64).optional(),
    recur: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
    recurUntil: z.string().datetime().nullable().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ id, ...rest }) => {
    const row = await updateEvent(OWNER_ID!, id, rest);
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
  },
);

server.tool(
  'event_delete',
  'Delete a calendar event by id. Pending reminders will not fire.',
  { id: z.string() },
  async ({ id }) => {
    const ok = await deleteEvent(OWNER_ID!, id);
    return { content: [{ type: 'text', text: ok ? 'deleted' : 'not found' }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mantle-mcp] listening on stdio. Owner:', OWNER_ID);
