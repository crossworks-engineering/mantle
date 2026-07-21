/**
 * Mantle MCP server builder — the single source of truth for the MCP tool
 * surface, shared by BOTH transports:
 *   - the stdio entry (`apps/mcp/src/server.ts`), spawned by Claude Desktop /
 *     Code over JSON-RPC on a trusted local machine;
 *   - the remote HTTP endpoint (`apps/web/app/api/mcp/route.ts`), reached as a
 *     claude.ai custom connector behind OAuth.
 *
 * `registerMantleTools(server, ownerId)` registers every tool onto a given
 * `McpServer`, scoped to `ownerId`; `buildMantleMcpServer(ownerId)` creates a
 * fresh server and registers them. The owner is a TRUSTED input here — each
 * transport authenticates and resolves it (stdio: the single local owner; HTTP:
 * the OAuth bearer) BEFORE calling in. No tool is more dangerous over HTTP than
 * over stdio (no shell tool is exposed); the new exposure is purely that the
 * surface is reachable over the network, which the transport's auth gates.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  db,
  agentGroups,
  agents,
  channels,
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
  graphPath,
  searchEntities,
  searchNodes,
  searchChunks,
  readSection,
} from '@mantle/search';
import { embed } from '@mantle/embeddings';
import { runSimulatedResponderTurn } from '@mantle/assistant-runtime';
import { accountForChat, editMessage, reactToMessage, sendMessage } from '@mantle/telegram';
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
  renameFileById,
  renameFolderById,
  updateFolderDescription,
  upsertFile,
  MAX_UPLOAD_BYTES,
} from '@mantle/files';
import {
  approvePendingCall,
  getPendingCall,
  listPendingCalls,
  rejectPendingCall,
  CONTACT_TOOLS,
  WORKER_DELEGATION_TOOLS,
  EXPORT_TOOLS,
  PAGE_TOOLS,
  TABLE_TOOLS,
  APP_TOOLS,
  TOOLSMITH_TOOLS,
} from '@mantle/tools';
import type { BuiltinToolDef } from '@mantle/tools';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  createEvent,
  createNote,
  createTask,
  deleteEvent,
  deleteNote,
  deleteTask,
  createJournal,
  deleteJournal,
  getEvent,
  getJournal,
  getNote,
  getPage,
  getTable,
  getTask,
  listEvents,
  listJournals,
  listNotes,
  listPages,
  listTables,
  listRows,
  ensureTableDoc,
  listTasks,
  listPeers,
  queryPeer,
  getPeerNode,
  updateEvent,
  updateJournal,
  updateNote,
  updateTask,
} from '@mantle/content';
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';

/** Mutating Toolsmith tools — gated behind MANTLE_MCP_TOOLSMITH_WRITE (default
 *  ON). Module-scope (env is process-stable) so the gate is evaluated once, not
 *  per build — for the HTTP transport a server is built per request. */
const TOOLSMITH_WRITE_SLUGS = new Set([
  'api_tool_create',
  'api_tool_update',
  'api_tool_delete',
  'recipe_tool_create',
  'tool_group_ensure',
  'agent_grant_tool_group',
]);
const toolsmithWriteEnabled = !/^(0|false|off|no)$/i.test(
  process.env.MANTLE_MCP_TOOLSMITH_WRITE ?? '',
);
if (!toolsmithWriteEnabled) {
  console.error(
    '[mantle-mcp] MANTLE_MCP_TOOLSMITH_WRITE is off — exposing Toolsmith read-only ' +
      `(skipping ${[...TOOLSMITH_WRITE_SLUGS].join(', ')}).`,
  );
}

/** Register every Mantle MCP tool onto `server`, scoped to `ownerId`. Both the
 *  stdio entry and the HTTP route call this; `ownerId` is already authenticated
 *  by the caller. */
export function registerMantleTools(server: McpServer, ownerId: string): void {
  // ─── response hygiene ───────────────────────────────────────────────────────
  // MCP tool results are serialised straight into the model's context, so they
  // must NOT leak raw DB internals. A `select()` row carries `embedding` (768
  // floats ≈ 9 KB) and `searchTsv` (the full tsvector ≈ 50 KB on a big doc) —
  // pure noise to a reader that blows the context budget (a single `search` hit
  // measured 125 KB, an `entity_search` for one name 76 KB, ~98% vectors). Strip
  // those keys from every row before it goes out. See docs/recall-eval.md and the
  // audit that motivated this.
  const STRIP_KEYS = new Set(['embedding', 'searchTsv', 'search_tsv']);
  function stripVectors<T>(value: T): T {
    if (Array.isArray(value)) return value.map((v) => stripVectors(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (STRIP_KEYS.has(k)) continue;
        out[k] = stripVectors(v);
      }
      return out as T;
    }
    return value;
  }

  /** Standard JSON tool reply, with vectors/tsvector stripped. */
  function jsonReply(value: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(stripVectors(value), null, 2) }],
    };
  }

  /** Lean projection of a node for list/search results: the "spine" (title, tags,
   *  summary), never the full body (`data.content`) or the index internals. Use
   *  node_read / file_read to fetch a body on demand. Mirrors the in-process
   *  `search_nodes` builtin so the two tool surfaces don't drift. */
  function leanNode(n: {
    id: string;
    type: string;
    title: string;
    path: string | null;
    tags: string[] | null;
    data: unknown;
    updatedAt: Date;
  }) {
    const data = (n.data ?? {}) as Record<string, unknown>;
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      path: n.path,
      tags: n.tags,
      summary: typeof data.summary === 'string' ? data.summary : null,
      updatedAt: n.updatedAt instanceof Date ? n.updatedAt.toISOString() : n.updatedAt,
    };
  }

  server.tool(
    'tree_list',
    'List children of a branch in the Mantle tree. Pass no path for top-level branches.',
    { path: z.string().optional() },
    async ({ path }) => {
      const rows = await db
        .select({ id: nodes.id, title: nodes.title, type: nodes.type, path: nodes.path })
        .from(nodes)
        .where(
          and(eq(nodes.ownerId, ownerId), path ? eq(nodes.path, path) : eq(nodes.type, 'branch')),
        )
        .limit(200);
      return jsonReply(rows);
    },
  );

  server.tool(
    'search',
    "Hybrid semantic + full-text search over the user's Mantle — ranks by meaning (vector) with keyword as a booster, so vague/natural queries work, not just exact words. Use `branch` (ltree path) to scope, `type` to filter. Returns the spine (title, tags, summary) — use node_read / file_read / email_get for a full body.",
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
          'documentation',
        ])
        .optional(),
      tags: z.array(z.string()).optional(),
      since: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ q, branch, type, tags, since, limit }) => {
      // Embed the query so searchNodes runs its hybrid (vector-led) ranker. The
      // legacy FTS-only path recalled ~8% on natural-language queries
      // (docs/recall-eval.md); a failed embed degrades to FTS, not an error.
      let queryEmbedding: number[] | undefined;
      if (q && q.trim()) {
        try {
          queryEmbedding = await embed(ownerId, q);
        } catch (err) {
          console.error('[search] query embed failed, falling back to FTS:', err);
        }
      }
      const results = await searchNodes({
        ownerId: ownerId,
        q,
        branch,
        type,
        tags,
        since: since ? new Date(since) : undefined,
        limit,
        queryEmbedding,
      });
      return jsonReply(results.map(leanNode));
    },
  );

  server.tool(
    'search_chunks',
    "Hybrid (semantic + keyword) search over document passages — finds the most relevant *sections* inside pages, files, emails, notes (not just whole-node keyword hits). Reach for this FIRST on a content question: it returns the exact passages, so you answer without loading whole documents into context. Fall back to `search` (whole-node) or reading the full file only when the passages are insufficient or the user wants an exhaustive read. `branch` scopes by ltree path (e.g. 'files' or 'pages').",
    {
      q: z.string(),
      branch: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ q, branch, limit }) => {
      const embedding = await embed(ownerId, q);
      const hits = await searchChunks({
        ownerId: ownerId,
        embedding,
        q,
        branch,
        limit: limit ?? 10,
      });
      return jsonReply(hits);
    },
  );

  server.tool(
    'read_section',
    "Read one SECTION of a long document in full and in order — the rung between `search_chunks` (scattered passages) and reading the whole file. Use once you know WHERE the answer lives (search_chunks returns each passage's nodeId, heading, ordinal). Pass ONLY `node_id` for the OUTLINE (heading ranges); pass `heading` for every passage under that heading; or `from_ordinal`/`to_ordinal` for a contiguous range. Output is capped (~24k chars) with a `next_ordinal` to continue from. Only read the whole file for short documents or when the outline shows no indexed passages.",
    {
      node_id: z.string().uuid(),
      heading: z.string().optional(),
      from_ordinal: z.number().int().min(0).optional(),
      to_ordinal: z.number().int().min(0).optional(),
      max_chars: z.number().int().min(2000).max(60000).optional(),
    },
    async ({ node_id, heading, from_ordinal, to_ordinal, max_chars }) => {
      const res = await readSection({
        ownerId,
        nodeId: node_id,
        heading,
        fromOrdinal: from_ordinal,
        toOrdinal: to_ordinal,
        maxChars: max_chars,
      });
      if ('error' in res) return { content: [{ type: 'text', text: res.error }], isError: true };
      return jsonReply(res);
    },
  );

  server.tool(
    'email_get',
    'Fetch a single email by id (body, headers, attachment refs).',
    { id: z.string().uuid() },
    async ({ id }) => {
      const [row] = await db.select().from(emails).where(eq(emails.id, id)).limit(1);
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      return jsonReply(row);
    },
  );

  server.tool(
    'email_list',
    'Recent emails newest-first. Optionally filter by `accountId` or `since`.',
    {
      accountId: z.string().uuid().optional(),
      since: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ accountId, since, limit }) => {
      const conds: SQL[] = [];
      if (accountId) conds.push(eq(emails.accountId, accountId));
      if (since) conds.push(eq(emails.internalDate, new Date(since)));
      const rows = await db
        .select()
        .from(emails)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(emails.internalDate))
        .limit(limit ?? 50);
      return jsonReply(rows);
    },
  );

  // ─── files / folders ──────────────────────────────────────────────────────

  server.tool(
    'folder_list',
    "List folders in the user's host-mirrored filesystem. Pass `parent` (ltree path, e.g. 'files.work') to list immediate children of that folder; pass `tree: true` to get every folder in the subtree at once. With no args, returns the immediate children of the root.",
    {
      parent: z.string().optional(),
      tree: z.boolean().optional(),
    },
    async ({ parent, tree }) => {
      await ensureFilesRootBranch(ownerId);
      if (tree) {
        const all = await listAllFolders(ownerId);
        return jsonReply(all);
      }
      const rows = await listFolders({ ownerId: ownerId, parentPath: parent ?? 'files' });
      return jsonReply(rows);
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
      await ensureFilesRootBranch(ownerId);
      try {
        const folder = await createFolder({
          ownerId: ownerId,
          parentPath: parent_path,
          slug,
          description,
        });
        return jsonReply(folder);
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
        const found = await folderByPath({ ownerId: ownerId, path });
        id = found?.id ?? null;
      }
      if (!id) {
        return {
          content: [{ type: 'text', text: 'folder_describe: pass folder_id or path' }],
          isError: true,
        };
      }
      const updated = await updateFolderDescription({
        ownerId: ownerId,
        folderId: id,
        description,
      });
      if (!updated) {
        return { content: [{ type: 'text', text: 'folder not found' }], isError: true };
      }
      return jsonReply(updated);
    },
  );

  server.tool(
    'folder_rename',
    'Rename a folder in place. `new_name` is lowercased + sanitised. Every file and sub-folder inside moves with it (their paths update). Pass `folder_id` or `path`. Cannot rename the `files` root.',
    {
      folder_id: z.string().uuid().optional(),
      path: z.string().optional(),
      new_name: z.string().min(1).max(64),
    },
    async ({ folder_id, path, new_name }) => {
      let id = folder_id ?? null;
      if (!id && path) {
        const found = await folderByPath({ ownerId: ownerId, path });
        id = found?.id ?? null;
      }
      if (!id) {
        return {
          content: [{ type: 'text', text: 'folder_rename: pass folder_id or path' }],
          isError: true,
        };
      }
      try {
        const updated = await renameFolderById({
          ownerId: ownerId,
          folderId: id,
          newSlug: new_name,
        });
        if (!updated) {
          return { content: [{ type: 'text', text: 'folder not found' }], isError: true };
        }
        return jsonReply(updated);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `folder_rename failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'folder_delete',
    'Delete a folder. Refuses unless the folder is empty — clear its children first. Cannot delete the `files` root.',
    { folder_id: z.string().uuid() },
    async ({ folder_id }) => {
      const res = await deleteFolder({ ownerId: ownerId, folderId: folder_id });
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
      const rows = await listFiles({ ownerId: ownerId, parentPath: parent_path });
      return jsonReply(rows);
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
      const bytes =
        content_text != null
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
          ownerId: ownerId,
          parentPath: parent_path,
          filename,
          bytes,
          overwrite,
        });
        return jsonReply(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `file_upload failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'file_read',
    'Read a file by id. For text files returns the content as a utf-8 string; for binaries returns base64-encoded bytes (only call this on small files).',
    { file_id: z.string().uuid() },
    async ({ file_id }) => {
      const res = await readFileById({ ownerId: ownerId, fileId: file_id });
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
      return jsonReply(out);
    },
  );

  server.tool(
    'file_get',
    "Fetch a file's metadata by id without loading bytes. Useful for resolving a uuid surfaced by search before deciding what to do with it.",
    { file_id: z.string().uuid() },
    async ({ file_id }) => {
      const row = await fileById({ ownerId: ownerId, fileId: file_id });
      if (!row) {
        return { content: [{ type: 'text', text: 'file not found' }], isError: true };
      }
      return jsonReply(row);
    },
  );

  server.tool(
    'file_rename',
    'Rename a file in place — its folder and extension are kept, only the basename changes. `new_stem` is the new name WITHOUT the extension (e.g. `huntsman-report` → `customerx-report`).',
    { file_id: z.string().uuid(), new_stem: z.string().min(1).max(200) },
    async ({ file_id, new_stem }) => {
      try {
        const row = await renameFileById({ ownerId: ownerId, fileId: file_id, newStem: new_stem });
        if (!row) {
          return { content: [{ type: 'text', text: 'file not found' }], isError: true };
        }
        return jsonReply(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `file_rename failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'file_delete',
    'Delete a file by id. Removes both the DB row and the on-disk file.',
    { file_id: z.string().uuid() },
    async ({ file_id }) => {
      const res = await deleteFileById({ ownerId: ownerId, fileId: file_id });
      if (!res.ok) {
        const text =
          res.reason === 'attachment'
            ? "can't delete — this file is an email attachment; delete it from the email instead"
            : 'file not found';
        return { content: [{ type: 'text', text }], isError: true };
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
      const rows = await listPendingCalls(ownerId, { status: status ?? 'pending', limit });
      return jsonReply(rows);
    },
  );

  server.tool(
    'pending_approve',
    'Approve a queued tool call by id. The handler runs immediately under a fresh `manual` trace; the result is stored on the pending row and returned. For a runner `ask_human` question, approval completes the run step and `answer` carries the free-text reply the run continues with (omit it for a plain yes / option-pick approval).',
    { id: z.string().uuid(), answer: z.string().max(4000).optional() },
    async ({ id, answer }) => {
      const row = await approvePendingCall(ownerId, id, answer ? { answer } : undefined);
      if (!row) {
        return { content: [{ type: 'text', text: 'not found or already decided' }], isError: true };
      }
      return jsonReply(row);
    },
  );

  server.tool(
    'pending_reject',
    "Reject a queued tool call by id. No execution; just flips status to 'rejected'. A runner `ask_human` question completes its run step failed(rejected) so the run advances instead of waiting forever.",
    { id: z.string().uuid() },
    async ({ id }) => {
      const row = await rejectPendingCall(ownerId, id);
      if (!row) {
        return { content: [{ type: 'text', text: 'not found or already decided' }], isError: true };
      }
      return jsonReply(row);
    },
  );

  server.tool(
    'worker_group_list',
    'List worker groups (panels) for runner queues. A run step with group:<slug> fans out into one attempt per member worker plus a panel audit.',
    {},
    async () => {
      const rows = await db.select().from(agentGroups).where(eq(agentGroups.ownerId, ownerId));
      return jsonReply(rows);
    },
  );

  server.tool(
    'worker_group_ensure',
    "Create or update a worker group (panel) by slug. `members` are enabled worker-agent slugs — each must exist (agent_list shows agents; role 'worker'). Idempotent upsert.",
    {
      slug: z.string().min(1).max(64),
      name: z.string().max(200).optional(),
      members: z.array(z.string().min(1)).min(1).max(10),
      enabled: z.boolean().optional(),
    },
    async ({ slug, name, members, enabled }) => {
      const workers = await db
        .select({ slug: agents.slug })
        .from(agents)
        .where(
          and(eq(agents.ownerId, ownerId), eq(agents.role, 'worker'), eq(agents.enabled, true)),
        );
      const have = new Set(workers.map((w) => w.slug));
      const missing = members.filter((m) => !have.has(m));
      if (missing.length > 0) {
        const available = workers.map((w) => w.slug).join(', ') || '(none yet)';
        return {
          content: [
            {
              type: 'text',
              text: `unknown worker(s): ${missing.join(', ')} — enabled worker agents: ${available}. Create workers first (settings → agents, role 'worker').`,
            },
          ],
          isError: true,
        };
      }
      const [existing] = await db
        .select({ id: agentGroups.id })
        .from(agentGroups)
        .where(and(eq(agentGroups.ownerId, ownerId), eq(agentGroups.slug, slug)));
      const values = {
        name: name ?? slug,
        memberSlugs: members,
        ...(enabled !== undefined ? { enabled } : {}),
        updatedAt: new Date(),
      };
      const [row] = existing
        ? await db
            .update(agentGroups)
            .set(values)
            .where(eq(agentGroups.id, existing.id))
            .returning()
        : await db
            .insert(agentGroups)
            .values({ ownerId, slug, ...values })
            .returning();
      return jsonReply(row);
    },
  );

  server.tool(
    'pending_get',
    'Fetch a pending tool call by id — useful to inspect the args before deciding.',
    { id: z.string().uuid() },
    async ({ id }) => {
      const row = await getPendingCall(ownerId, id);
      if (!row) {
        return { content: [{ type: 'text', text: 'not found' }], isError: true };
      }
      return jsonReply(row);
    },
  );

  // ─── entities ─────────────────────────────────────────────────────────────

  server.tool(
    'entity_search',
    "Resolve a name or alias to entities in the user's memory. Exact name/alias matches return similarity=1; otherwise trigram fuzzy match. Optional `kind` filter (person, project, place, org, event, ...).",
    {
      q: z.string().min(1),
      kind: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ q, kind, limit }) => {
      const hits = await searchEntities({ ownerId: ownerId, q, kind, limit });
      return jsonReply(hits);
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
        ownerId: ownerId,
        entityId: entity_id,
        relation,
        direction,
        currentOnly: current_only,
        limit,
      });
      return jsonReply(rows);
    },
  );

  server.tool(
    'graph_path',
    "Multi-hop traversal of the entity knowledge graph (relationships BETWEEN entities). Pass from_id + to_id for the shortest path(s) between two entities ('how is Sarah connected to Acme?'); pass from_id only for everything reachable within max_depth ('what's within 2 hops of Lister?'). `relations` limits which verbs to follow; `directed:true` follows subject→object only (default undirected). For a single hop use entity_neighbors.",
    {
      from_id: z.string().uuid(),
      to_id: z.string().uuid().optional(),
      max_depth: z.number().int().min(1).max(6).optional(),
      relations: z.array(z.string()).optional(),
      directed: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ from_id, to_id, max_depth, relations, directed, limit }) => {
      const rows = await graphPath({
        ownerId: ownerId,
        fromId: from_id,
        toId: to_id,
        maxDepth: max_depth,
        relations,
        directed,
        limit,
      });
      return jsonReply(rows);
    },
  );

  server.tool(
    'entity_facts',
    'All facts attached to an entity. By default returns currently-valid facts only; set `include_retired=true` to see superseded history too. Use after entity_search to get \'"what do I know about Sarah?"\' answers.',
    {
      entity_id: z.string().uuid(),
      include_retired: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ entity_id, include_retired, limit }) => {
      const rows = await entityFacts({
        ownerId: ownerId,
        entityId: entity_id,
        includeRetired: include_retired,
        limit,
      });
      return jsonReply(rows);
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
      const rows = await entityMentions({ ownerId: ownerId, entityId: entity_id, limit });
      return jsonReply(rows);
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
      return jsonReply(rows);
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
          and(eq(telegramChats.accountId, account.id), eq(telegramChats.telegramChatId, chat_id)),
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
        .where(and(eq(telegramChats.pairingCode, code), eq(telegramChats.userId, ownerId)))
        .limit(1);
      if (!chat) {
        return {
          content: [{ type: 'text', text: 'no pending pairing with that code' }],
          isError: true,
        };
      }
      if (chat.allowlistStatus === 'allowed') {
        return { content: [{ type: 'text', text: 'already paired' }] };
      }
      if (chat.pairingExpiresAt && chat.pairingExpiresAt.getTime() < Date.now()) {
        return {
          content: [{ type: 'text', text: 'code expired — ask them to DM again' }],
          isError: true,
        };
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
        if (account.channelId) {
          const [agentRow] = await db
            .select({ name: agents.name })
            .from(agents)
            .innerJoin(channels, eq(channels.agentId, agents.id))
            .where(eq(channels.id, account.channelId))
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
          {
            type: 'text',
            text: `paired chat ${chat.telegramChatId} (${chat.title ?? chat.username ?? 'unnamed'})`,
          },
        ],
      };
    },
  );

  // ─── Notes / Tasks / Events ────────────────────────────────────────────────
  //
  // Three content surfaces the assistant can drive. All three are jsonb on
  // `nodes` (no dedicated tables) and all three flow through the extractor
  // for summary + embedding, so semantic search ("what notes do I have
  // about X?") works without explicit indexing here.

  server.tool(
    'note_list',
    "List the owner's notes. Optional `query` does a substring match against title/body/summary; `tag` filters to notes carrying that tag. Agent conversation digests are excluded unless `tag` is one of their tags (`conversation-digest`, `agent:*`, `topic:*`).",
    {
      query: z.string().optional(),
      tag: z.string().optional(),
    },
    async ({ query, tag }) => {
      const rows = await listNotes(ownerId, { query, tag });
      return jsonReply(rows);
    },
  );

  server.tool(
    'note_get',
    'Get a single note by id, including its full markdown content.',
    { id: z.string() },
    async ({ id }) => {
      const row = await getNote(ownerId, id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      return jsonReply(row);
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
      const row = await createNote(ownerId, {
        title,
        content: content ?? '',
        tags: tags ?? [],
      });
      return jsonReply(row);
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
      const row = await updateNote(ownerId, id, { title, content, tags });
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      return jsonReply(row);
    },
  );

  server.tool('note_delete', 'Delete a note by id.', { id: z.string() }, async ({ id }) => {
    const ok = await deleteNote(ownerId, id);
    return { content: [{ type: 'text', text: ok ? 'deleted' : 'not found' }] };
  });

  // ─── Journal ─────────────────────────────────────────────────────────────
  //
  // The owner's first-person self-knowledge (type='journal'): short entries with
  // an optional mood + life-area category. These feed the always-on "who you are"
  // identity context injected into every agent turn — so logging from Claude
  // Desktop teaches the in-app assistant who the user is. Full CRUD, mirroring
  // notes (the upstream-ingest surface is where self-facts naturally get added).

  server.tool(
    'journal_list',
    "List the owner's Journal — their notes about who they are, their work, family, faith, health, goals, and feelings, newest first. Optional `query` substring-matches title/body/summary; `mood` / `category` filter.",
    {
      query: z.string().optional(),
      mood: z.string().optional(),
      category: z.string().optional(),
    },
    async ({ query, mood, category }) => {
      const rows = await listJournals(ownerId, { query, mood, category });
      return jsonReply(rows);
    },
  );

  server.tool(
    'journal_get',
    'Get a single journal entry by id.',
    { id: z.string() },
    async ({ id }) => {
      const row = await getJournal(ownerId, id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      return jsonReply(row);
    },
  );

  server.tool(
    'journal_create',
    "Record a short first-person journal entry — something durable about who the user is, what they're doing, or how they feel. `body` is a short paragraph; `mood` and `category` are optional. Becomes part of the assistant's always-on understanding of the user.",
    {
      body: z.string().min(1).max(20_000),
      title: z.string().max(200).optional(),
      mood: z.string().max(40).optional(),
      category: z.string().max(40).optional(),
      entryDate: z.string().max(40).optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ body, title, mood, category, entryDate, tags }) => {
      const row = await createJournal(ownerId, {
        body,
        title,
        mood,
        category,
        entryDate,
        tags: tags ?? [],
      });
      return jsonReply(row);
    },
  );

  server.tool(
    'journal_update',
    'Update a journal entry. Pass only the fields you want changed; an empty string clears mood/category/entryDate.',
    {
      id: z.string(),
      body: z.string().max(20_000).optional(),
      title: z.string().max(200).optional(),
      mood: z.string().max(40).optional(),
      category: z.string().max(40).optional(),
      entryDate: z.string().max(40).optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ id, body, title, mood, category, entryDate, tags }) => {
      const row = await updateJournal(ownerId, id, {
        body,
        title,
        mood,
        category,
        entryDate,
        tags,
      });
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      return jsonReply(row);
    },
  );

  server.tool(
    'journal_delete',
    'Delete a journal entry by id.',
    { id: z.string() },
    async ({ id }) => {
      const ok = await deleteJournal(ownerId, id);
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
      const rows = await listPages(ownerId, { query, tag });
      return jsonReply(rows);
    },
  );

  server.tool(
    'page_get',
    'Get a single page by id, including its full ProseMirror/TipTap document.',
    { id: z.string() },
    async ({ id }) => {
      const row = await getPage(ownerId, id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      return jsonReply(row);
    },
  );

  // ─── Pages (write) ───────────────────────────────────────────────────────────
  // The rich-document authoring surface — create pages (blank / from a file,
  // note(s), or journal), edit metadata + draft body, and do block-level edits
  // (list/get/update/insert/delete/split/extract/move blocks) plus mention/share.
  // Bridged from the in-app PAGE_TOOLS so an MCP client authors with the exact
  // same tested handlers the `pages` agent uses. page_list/page_get are skipped:
  // they're already hand-wired above (those return the raw ProseMirror document;
  // the builtin read tools return plaintext + block ids — left as the read path
  // for the in-app agent to avoid changing the existing MCP read shape).
  const PAGE_READ_SLUGS = new Set(['page_list', 'page_get']);
  registerBuiltinTools(PAGE_TOOLS, { skip: (def) => PAGE_READ_SLUGS.has(def.slug) });

  // ─── Tables (read-only) ────────────────────────────────────────────────────
  //
  // Typed database grids (type='table'). Read-only over MCP — tables are authored
  // in the web grid editor + by the Tables agent. table_list omits the grid;
  // table_get returns columns + a row window; table_rows_list is the addressable
  // row snapshot.

  server.tool(
    'table_list',
    "List the owner's tables. Optional `query` substring-matches title/body/summary; `tag` filters. Grids are summarised (column + row counts) — use table_get for content.",
    {
      query: z.string().optional(),
      tag: z.string().optional(),
    },
    async ({ query, tag }) => {
      const rows = await listTables(ownerId, { query, tag });
      return jsonReply(rows);
    },
  );

  server.tool(
    'table_get',
    'Get a single table by id: its columns and a window of rows (formula columns resolved). `offset`/`limit` page large grids.',
    { id: z.string(), offset: z.number().optional(), limit: z.number().optional() },
    async ({ id, offset, limit }) => {
      const row = await getTable(ownerId, id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      const doc = ensureTableDoc(row.data);
      const listed = listRows(doc, { offset: offset ?? 0, limit: limit ?? 100 });
      const out = {
        id: row.id,
        title: row.title,
        tags: row.tags,
        summary: row.summary,
        columns: doc.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        rows: listed.rows,
        total_rows: listed.total,
        aggregates: doc.aggregates ?? {},
      };
      return jsonReply(out);
    },
  );

  server.tool(
    'table_rows_list',
    "Windowed snapshot of a table's rows — each a stable id + short per-cell text. Page via offset/limit.",
    { table_id: z.string(), offset: z.number().optional(), limit: z.number().optional() },
    async ({ table_id, offset, limit }) => {
      const row = await getTable(ownerId, table_id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      const listed = listRows(ensureTableDoc(row.data), {
        offset: offset ?? 0,
        limit: limit ?? 50,
      });
      return jsonReply(listed);
    },
  );

  // ─── Tables (write) ───────────────────────────────────────────────────────────
  // Build + operate typed data grids: create (blank / from a file or text),
  // update metadata, edit rows (add/update/delete + per-cell set), edit columns
  // (add/update/delete), set aggregates + views, query/aggregate over rows, and
  // commit drafts. Bridged from the in-app TABLE_TOOLS so an MCP client uses the
  // same tested handlers the Tables agent uses. table_list/table_get/
  // table_rows_list are skipped — already hand-wired above (read-only) — to keep
  // the existing MCP read shape unchanged.
  const TABLE_READ_SLUGS = new Set(['table_list', 'table_get', 'table_rows_list']);
  registerBuiltinTools(TABLE_TOOLS, { skip: (def) => TABLE_READ_SLUGS.has(def.slug) });

  server.tool(
    'task_list',
    'List tasks. `status` filters open/done; `priority` filters low/normal/high; `query` substring-matches title/body/summary. Default sort: open first, soonest due, then most-recently updated.',
    {
      query: z.string().optional(),
      status: z.enum([...TASK_STATUSES, 'all'] as ['open', 'done', 'all']).optional(),
      priority: z.enum([...TASK_PRIORITIES, 'all'] as ['low', 'normal', 'high', 'all']).optional(),
      tag: z.string().optional(),
    },
    async ({ query, status, priority, tag }) => {
      const rows = await listTasks(ownerId, {
        query,
        status: status ?? 'all',
        priority: priority ?? 'all',
        tag,
      });
      return jsonReply(rows);
    },
  );

  server.tool('task_get', 'Get a single task by id.', { id: z.string() }, async ({ id }) => {
    const row = await getTask(ownerId, id);
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return jsonReply(row);
  });

  server.tool(
    'task_create',
    'Create a task. Title is required. `dueAt` is an ISO 8601 timestamp (e.g. "2026-05-25T17:00:00Z").',
    {
      title: z.string().min(1).max(200),
      body: z.string().max(50_000).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      dueAt: z.string().datetime().nullable().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ title, body, status, priority, dueAt, tags }) => {
      const row = await createTask(ownerId, {
        title,
        body,
        status,
        priority,
        dueAt,
        tags,
      });
      return jsonReply(row);
    },
  );

  server.tool(
    'task_update',
    'Update a task. Use this to flip status to "done", change priority, push the due date, etc.',
    {
      id: z.string(),
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(50_000).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      dueAt: z.string().datetime().nullable().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ id, ...rest }) => {
      const row = await updateTask(ownerId, id, rest);
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      return jsonReply(row);
    },
  );

  server.tool('task_delete', 'Delete a task by id.', { id: z.string() }, async ({ id }) => {
    const ok = await deleteTask(ownerId, id);
    return { content: [{ type: 'text', text: ok ? 'deleted' : 'not found' }] };
  });

  server.tool(
    'event_list',
    'List calendar events. `window` defaults to "upcoming"; use "past" or "all" to see history. `query` substring-matches title/body/location/summary.',
    {
      query: z.string().optional(),
      window: z.enum(['upcoming', 'past', 'all']).optional(),
      tag: z.string().optional(),
    },
    async ({ query, window, tag }) => {
      const rows = await listEvents(ownerId, { query, window, tag });
      return jsonReply(rows);
    },
  );

  server.tool('event_get', 'Get a single event by id.', { id: z.string() }, async ({ id }) => {
    const row = await getEvent(ownerId, id);
    if (!row) return { content: [{ type: 'text', text: 'not found' }] };
    return jsonReply(row);
  });

  server.tool(
    'event_create',
    'Create a calendar event. `startsAt` is an ISO 8601 instant. `remindMinutesBefore` controls when the Telegram reminder fires (0 = right at start). The reminder lands in the owner\'s most-recent allowed Telegram DM. `timezone` is an optional IANA tz (e.g. "Africa/Johannesburg") used to format the reminder message — the storage is always UTC. Set `recur` (daily/weekly/monthly/yearly) to repeat; `recurUntil` (ISO) caps the series.',
    {
      title: z.string().min(1).max(200),
      body: z.string().max(50_000).optional(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime().nullable().optional(),
      location: z.string().max(200).nullable().optional(),
      remindMinutesBefore: z
        .number()
        .int()
        .min(0)
        .max(60 * 24 * 30)
        .optional(),
      timezone: z.string().max(64).optional(),
      recur: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
      recurUntil: z.string().datetime().nullable().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      const row = await createEvent(ownerId, args);
      return jsonReply(row);
    },
  );

  server.tool(
    'event_update',
    "Update a calendar event. If you move `startsAt` or `remindMinutesBefore` and the new reminder time is still in the future, a previously-sent reminder will fire again. Pass `timezone` (IANA tz) to change how the reminder message formats the time. Set `recur` to change the repeat frequency ('none' stops it); `recurUntil` caps the series.",
    {
      id: z.string(),
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(50_000).optional(),
      startsAt: z.string().datetime().optional(),
      endsAt: z.string().datetime().nullable().optional(),
      location: z.string().max(200).nullable().optional(),
      remindMinutesBefore: z
        .number()
        .int()
        .min(0)
        .max(60 * 24 * 30)
        .optional(),
      timezone: z.string().max(64).optional(),
      recur: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
      recurUntil: z.string().datetime().nullable().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ id, ...rest }) => {
      const row = await updateEvent(ownerId, id, rest);
      if (!row) return { content: [{ type: 'text', text: 'not found' }] };
      return jsonReply(row);
    },
  );

  server.tool(
    'event_delete',
    'Delete a calendar event by id. Pending reminders will not fire.',
    { id: z.string() },
    async ({ id }) => {
      const ok = await deleteEvent(ownerId, id);
      return { content: [{ type: 'text', text: ok ? 'deleted' : 'not found' }] };
    },
  );

  // ── Federation: query other people's Mantles for data they've shared ─────────
  server.tool(
    'peer_list',
    'List the federated Mantle peers configured for this account — other Mantle systems you can query for data they have shared with you. Returns each peer id, name, base URL, and status.',
    {},
    async () => {
      const peers = await listPeers(ownerId);
      return jsonReply(peers);
    },
  );

  server.tool(
    'peer_query',
    "Ask a federated peer Mantle for data it has shared with you. `peer` is the peer's name or id (see peer_list); `query` matches the titles/summaries of nodes the peer GRANTED you — you only ever see what they shared. Optionally narrow by `types`. Use peer_node_get for one node's full content.",
    {
      peer: z.string(),
      query: z.string().max(500).optional(),
      types: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ peer, ...opts }) => {
      const res = await queryPeer(ownerId, peer, opts);
      return {
        content: [
          {
            type: 'text',
            text: res.ok ? JSON.stringify(stripVectors(res.data), null, 2) : `Error: ${res.error}`,
          },
        ],
      };
    },
  );

  server.tool(
    'peer_node_get',
    "Fetch one shared node's full content from a federated peer. `peer` is the peer's name or id; `nodeId` is an id from peer_query. Fails if the peer hasn't granted you that node.",
    { peer: z.string(), nodeId: z.string() },
    async ({ peer, nodeId }) => {
      const res = await getPeerNode(ownerId, peer, nodeId);
      return {
        content: [
          {
            type: 'text',
            text: res.ok ? JSON.stringify(stripVectors(res.data), null, 2) : `Error: ${res.error}`,
          },
        ],
      };
    },
  );

  /* ───────────────────────── Toolsmith over MCP ──────────────────────────
   *
   * The api_tool_* / tool_group_* / agent_* / web_fetch / api_key_refs set
   * lets an MCP client (Claude Code, Claude Desktop) author, test, group,
   * and grant templated HTTP API tools — the same capability the in-app
   * Toolsmith agent has, on the user's own Claude subscription instead of
   * Mantle's metered API key. "Read these Mapbox docs and build me the
   * tool set" works end-to-end from Claude Code.
   *
   * Registered straight from TOOLSMITH_TOOLS (single source of truth) via
   * a JSON-Schema→zod shape bridge, so the two surfaces cannot drift. The
   * handlers run with the MCP process's ownerId — same trust model as
   * every other tool in this file.
   *
   * Scoping: the read-only set (list/get/test/api_key_refs/web_fetch) is
   * always exposed. The mutating set — authoring (create/update/delete),
   * grouping (tool_group_ensure), and granting (agent_grant_tool_group) —
   * is gated on MANTLE_MCP_TOOLSMITH_WRITE, which defaults ON. Set it to
   * 0/false/off on a shared or headless deployment to expose Toolsmith
   * read-only while keeping tool authoring + granting to the in-app agent.
   */

  /** Convert one JSON-Schema property def into a zod type. Honors `items` for
   *  arrays, `integer` (vs number), nested object `properties`, and `[T,'null']`
   *  nullable unions — so validation isn't silently dropped if a Toolsmith def
   *  grows past the original string/number/boolean/array<string> vocabulary. */
  function zodForDef(def: Record<string, unknown>): z.ZodTypeAny {
    const type = def.type;
    if (Array.isArray(def.enum) && def.enum.every((v) => typeof v === 'string')) {
      return z.enum(def.enum as [string, ...string[]]);
    }
    if (Array.isArray(type)) {
      const base = type.find((x) => x !== 'null');
      const inner = base ? zodForDef({ ...def, type: base }) : z.unknown();
      return type.includes('null') ? inner.nullable() : inner;
    }
    switch (type) {
      case 'string':
        return z.string();
      case 'number':
        return z.number();
      case 'integer':
        return z.number().int();
      case 'boolean':
        return z.boolean();
      case 'array': {
        const items = (def.items ?? {}) as Record<string, unknown>;
        return z.array('type' in items || 'enum' in items ? zodForDef(items) : z.unknown());
      }
      case 'object': {
        const props = (def.properties ?? {}) as Record<string, Record<string, unknown>>;
        if (Object.keys(props).length === 0) return z.record(z.unknown());
        return z.object(buildZodShape(def));
      }
      default:
        return z.unknown();
    }
  }

  /** Build a zod raw shape from a JSON-Schema object node (properties + required). */
  function buildZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required as string[]) ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, def] of Object.entries(props)) {
      let t = zodForDef(def);
      if (typeof def.description === 'string') t = t.describe(def.description);
      if (!required.has(key)) t = t.optional();
      shape[key] = t;
    }
    return shape;
  }

  function zodShapeFromJsonSchema(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
    return buildZodShape(schema);
  }

  /** Bridge a set of in-app `BuiltinToolDef`s onto the MCP server, reusing the
   *  exact same handlers the in-app agent runs so the two surfaces never drift.
   *  Handlers get the minimal context `{ ownerId }` — every other `ctx` field
   *  (`step`, `surface`, `agent`) is optional and the handler degrades on its
   *  own (e.g. a worker tool that needs a Telegram chat refuses cleanly here).
   *  Binary `artifacts` are dropped (MCP results are text/JSON); tools that also
   *  persist their output to a node — e.g. `generate_image` → /files — still
   *  surface the node id in `output`. `opts.skip` lets a caller gate writes. */
  function registerBuiltinTools(
    defs: readonly BuiltinToolDef[],
    opts?: { skip?: (def: BuiltinToolDef) => boolean },
  ) {
    for (const def of defs) {
      if (opts?.skip?.(def)) continue;
      server.tool(
        def.slug,
        def.description,
        zodShapeFromJsonSchema(def.inputSchema),
        async (args: Record<string, unknown>) => {
          const result = await def.handler(args ?? {}, { ownerId: ownerId });
          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
              isError: true,
            };
          }
          return jsonReply(result.output);
        },
      );
    }
  }

  // ─── Contacts ────────────────────────────────────────────────────────────────
  // The email allowlist (nodes of type='contact'). Exposing these closes the gap
  // where an MCP client could read the brain but not extend the assistant's reach:
  // contact_create is what lets email_send target a new recipient (and kicks off
  // the 90-day inbound history backfill). Bridged from the in-app CONTACT_TOOLS so
  // both surfaces share one tested handler (incl. the enqueueBackfills side effect).
  registerBuiltinTools(CONTACT_TOOLS);

  // ─── Workers (modality delegation) ───────────────────────────────────────────
  // extract_from_image / summarize_text / generate_image run headless: they read
  // from the file store or take inline text and return text (or, for image gen, a
  // file node whose id is in the output — the base64 artifact is dropped over MCP
  // but the saved /files node is retrievable via file_read). synthesize_speech is
  // omitted: it structurally needs a live delivery surface (Telegram chat / web
  // reply stream) the MCP bridge can't supply, so it would only ever error here.
  registerBuiltinTools(WORKER_DELEGATION_TOOLS, {
    skip: (def) => def.slug === 'synthesize_speech',
  });

  // ─── Responder simulation ─────────────────────────────────────────────────────
  // Talk to a responder agent over MCP with the REAL pipeline (persona +
  // retrieval + real tool execution) but NOTHING persisted to its conversation
  // store. Input caps mirror the web Studio sandbox (40 turns, 8000 chars each).
  const SIM_MAX_HISTORY = 40;
  const SIM_MAX_CONTENT = 8000;
  const SIM_ARGS_CLIP = 500;
  server.tool(
    'respond_as_agent',
    "Talk to one of the user's responder agents as if you were the user, and get its reply. " +
      "Runs ONE real turn of that agent's pipeline — composed persona (identity + skills), real " +
      'memory retrieval, and its real granted tools, which EXECUTE: side effects happen and ' +
      'confirm-gated calls land on /pending (returned as `pending_ids`). Writes NOTHING to the ' +
      "agent's conversation history, so it's safe to probe repeatedly. Multi-turn is caller-held " +
      '— keep the transcript yourself and resend it in `history` every call. Omit `agent_slug` ' +
      'for the default responder; set `include_tool_calls` false to drop the per-call trail.',
    {
      message: z.string().min(1),
      agent_slug: z.string().optional(),
      history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
        .optional(),
      exclude_tools: z.array(z.string()).optional(),
      max_iterations: z.number().int().min(1).max(30).optional(),
      include_tool_calls: z.boolean().optional(),
    },
    async ({ message, agent_slug, history, exclude_tools, max_iterations, include_tool_calls }) => {
      // Cap the caller-held transcript before it reaches the model — an
      // unbounded resend would blow the context budget. Reject with a corrective
      // (say the limit + the fix) rather than silently truncating history.
      if (history && history.length > SIM_MAX_HISTORY) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `respond_as_agent: history has ${history.length} turns (max ${SIM_MAX_HISTORY}) — ` +
                'drop the oldest turns and resend, or start a fresh transcript.',
            },
          ],
          isError: true,
        };
      }
      const tooLong = (history ?? []).findIndex((t) => t.content.length > SIM_MAX_CONTENT);
      if (tooLong >= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `respond_as_agent: history entry ${tooLong} is ${history![tooLong]!.content.length} ` +
                `chars (max ${SIM_MAX_CONTENT}) — shorten or summarise that turn and resend.`,
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await runSimulatedResponderTurn(ownerId, {
          message,
          ...(agent_slug ? { agentSlug: agent_slug } : {}),
          ...(history ? { history } : {}),
          ...(exclude_tools ? { excludeToolSlugs: exclude_tools } : {}),
          ...(typeof max_iterations === 'number' ? { maxIterations: max_iterations } : {}),
        });
        const withCalls = include_tool_calls !== false;
        return jsonReply({
          reply: res.reply,
          agent: res.agent,
          ...(withCalls
            ? {
                tool_calls: res.toolCalls.map((tc) => ({
                  slug: tc.slug,
                  status: tc.status,
                  duration_ms: tc.durationMs,
                  // Clip args so a large payload doesn't blow the reply budget.
                  args:
                    tc.argsJson.length > SIM_ARGS_CLIP
                      ? `${tc.argsJson.slice(0, SIM_ARGS_CLIP)}…`
                      : tc.argsJson,
                  ...(tc.error ? { error: tc.error } : {}),
                })),
              }
            : {}),
          tool_stats: res.toolStats,
          pending_ids: res.pendingIds,
          trace_id: res.traceId,
          empty_reply_substituted: res.emptyReplySubstituted,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `respond_as_agent failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Export (Word / Excel) ───────────────────────────────────────────────────
  // Renders a page/note → .docx or a table → .xlsx into /files/exports and returns
  // the new file's id/path. Pure (no surface, no artifact) — bridges as-is.
  registerBuiltinTools(EXPORT_TOOLS);

  // ─── Apps (mini-app builder) ──────────────────────────────────────────────────
  // Author Mantle mini-apps end-to-end from an MCP client: create, write the TSX
  // source tree (app_file_write per file or app_source_set for the whole tree at
  // once), declare the data tools the app may broker (app_tools_set) + per-app
  // SQLite schema (app_db_schema_set), compile server-side via esbuild (app_build
  // returns file/line/column diagnostics to iterate on), preview, and publish.
  // The app reaches owner data only through its declared tool allowlist — pair
  // this with the Toolsmith tools below to mint the data-access tools an app needs.
  registerBuiltinTools(APP_TOOLS);

  // ─── Toolsmith ───────────────────────────────────────────────────────────────
  // Writes gated behind MANTLE_MCP_TOOLSMITH_WRITE (see TOOLSMITH_WRITE_SLUGS).
  registerBuiltinTools(TOOLSMITH_TOOLS, {
    skip: (def) => !toolsmithWriteEnabled && TOOLSMITH_WRITE_SLUGS.has(def.slug),
  });
}

/** Create a fresh `McpServer` with the full Mantle tool surface, scoped to
 *  `ownerId`. Used by the stdio entry; the HTTP route registers onto the
 *  adapter-provided server via `registerMantleTools`. */
export function buildMantleMcpServer(ownerId: string): McpServer {
  const server = new McpServer({ name: 'mantle', version: '0.0.1' });
  registerMantleTools(server, ownerId);
  return server;
}
