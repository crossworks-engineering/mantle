/**
 * Mantle MCP server.
 *
 * Exposes the user's tree, emails, files, telegram messages, and rules to
 * Claude over MCP. Defaults to stdio (Claude Desktop / Claude Code); pass
 * `--http` to bind an HTTP+SSE listener on $MCP_HTTP_PORT for remote use.
 *
 * Env loading is handled by Node's `--env-file-if-exists=.env.local` in the
 * package script; this entry just trusts `process.env`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  db,
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
} from '@mantle/search';
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
} from '@mantle/files';
import { and, asc, desc, eq } from 'drizzle-orm';

const OWNER_ID = process.env.ALLOWED_USER_ID;
if (!OWNER_ID) {
  console.error('ALLOWED_USER_ID must be set so the MCP server knows whose tree to expose.');
  process.exit(1);
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
      try {
        await sendMessage(account, chat.telegramChatId, 'Paired! Say hi to Claude.');
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mantle-mcp] listening on stdio. Owner:', OWNER_ID);
