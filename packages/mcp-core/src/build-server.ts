/**
 * Mantle MCP server builder — the single source of truth for the MCP tool
 * surface, shared by BOTH transports:
 *   - the stdio entry (`server/mcp/src/server.ts`), spawned by Claude Desktop /
 *     Code over JSON-RPC on a trusted local machine;
 *   - the remote HTTP endpoint (`server/web/app/api/mcp/route.ts`), reached as a
 *     claude.ai custom connector behind OAuth.
 *
 * `registerMantleTools(server, ownerId, opts)` registers every tool onto a given
 * `McpServer`, scoped to `ownerId`; `buildMantleMcpServer(ownerId)` creates a
 * fresh server and registers them. The owner is a TRUSTED input here — each
 * transport authenticates and resolves it (stdio: the single local owner; HTTP:
 * the OAuth bearer) BEFORE calling in.
 *
 * FULL PARITY is the rule: every tool an in-brain agent can be granted is on
 * this surface. A desktop client is not a lesser citizen than an agent running
 * inside the brain — it is the owner, authenticated, driving their own data.
 * The surface used to be a hand-picked subset, and every gap read to the client
 * as a missing capability it could not even name (the CLI sandboxes were
 * enabled on a box and the client still reported it had no such tool).
 *
 * ONE tool is transport-dependent: `run_terminal` runs a shell in the brain's
 * OWN container — postgres, minio, the file store, the master key. Over stdio
 * that is no escalation at all (spawning the process already grants the owner's
 * full data access on a machine you control), so it ships. Over HTTP the
 * surface is reachable from the network and a stolen OAuth token would become a
 * root shell on the box, so it is OFF unless the operator sets
 * MANTLE_MCP_TERMINAL=1. `sandbox_exec` — the contained shell, in a container
 * with no route to any of that — is unconditional on both.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  db,
  agentGroups,
  agents,
  channels,
  nodes,
  telegramAccounts,
  telegramChats,
  telegramMessages,
} from '@mantle/db';
import { searchNodes } from '@mantle/search';
import { embed } from '@mantle/embeddings';
import { describeResponderPersona, runSimulatedResponderTurn } from '@mantle/assistant-runtime';
import { accountForChat, editMessage, reactToMessage, sendMessage } from '@mantle/telegram';
import {
  createFolder,
  deleteFileById,
  deleteFolder,
  ensureFilesRootBranch,
  fileById,
  folderByPath,
  readFileById,
  renameFileById,
  renameFolderById,
  updateFolderDescription,
  upsertFile,
  MAX_UPLOAD_BYTES,
  setIndexingMode,
  MEDIA_EXTS,
  extOf,
} from '@mantle/files';
import {
  ASK_HUMAN_FORM_LIMITS as FORM_LIMITS,
  approvePendingCall,
  getPendingCall,
  listPendingCalls,
  rejectPendingCall,
  checkToolPreconditions,
  CONTACT_TOOLS,
  WORKER_DELEGATION_TOOLS,
  EXPORT_TOOLS,
  SHEET_TOOLS,
  PAGE_TOOLS,
  DRAW_TOOLS,
  TABLE_TOOLS,
  APP_TOOLS,
  TOOLSMITH_TOOLS,
  NOTE_TOOLS,
  TASK_TOOLS,
  EVENT_TOOLS,
  JOURNAL_TOOLS,
  PEER_TOOLS,
  EMAIL_TOOLS,
  FILE_MANAGE_TOOLS,
  RECALL_TOOLS,
  SANDBOX_TOOLS,
  NODE_READ_TOOLS,
  SEARCH_TOOLS,
  ENTITY_TOOLS,
  FILE_TOOLS,
  TELEGRAM_TOOLS,
  FILE_CREATE_TOOLS,
  CONTENT_CURATION_TOOLS,
  INGEST_TOOLS,
  SECRET_TOOLS,
  DELEGATION_TOOLS,
  CALCULATE_TOOLS,
  FORMULA_TOOLS,
  APP_DATA_TOOLS,
  REPLAY_TOOLS,
  IMAGE_TOOLS,
  TEAM_TOOLS,
  RESEARCH_TOOLS,
  CURATION_TOOLS,
  CRAWL_TOOLS,
  VIDEO_TOOLS,
  LOCATION_TOOLS,
  PERSONA_TOOLS,
  PROFILE_TOOLS,
  SHARE_TOOLS,
  RUN_TOOLS,
  TOOL_RESULT_TOOLS,
  EVAL_TOOLS,
  TERMINAL_TOOLS,
} from '@mantle/tools';
import type { BuiltinToolDef } from '@mantle/tools';
import {
  deleteFileWithDerived,
  deleteNote,
  describeDerivedCounts,
  getPage,
  getTable,
  listPages,
  listTables,
  listRows,
  ensureTableDoc,
} from '@mantle/content';
import { and, asc, eq } from 'drizzle-orm';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';

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
  // Integration-group writes: api_docs_set writes a file node + the group's docs
  // pointer, api_skill_set writes a skills row every granted agent then reads.
  // (api_docs_get is a read — always exposed.)
  'api_docs_set',
  'api_skill_set',
]);
const toolsmithWriteEnabled = !/^(0|false|off|no)$/i.test(env('MANTLE_MCP_TOOLSMITH_WRITE') ?? '');
if (!toolsmithWriteEnabled) {
  console.error(
    '[mantle-mcp] MANTLE_MCP_TOOLSMITH_WRITE is off — exposing Toolsmith read-only ' +
      `(skipping ${[...TOOLSMITH_WRITE_SLUGS].join(', ')}).`,
  );
}

/** Which transport is registering. Only `run_terminal` reads it (see the file
 *  header); everything else is identical on both. */
export type MantleMcpTransport = 'stdio' | 'http';

/** Register every Mantle MCP tool onto `server`, scoped to `ownerId`. Both the
 *  stdio entry and the HTTP route call this; `ownerId` is already authenticated
 *  by the caller. `transport` defaults to the SAFER of the two: a caller that
 *  forgets to say gets the network posture, never the trusted-local one. */
export function registerMantleTools(
  server: McpServer,
  ownerId: string,
  opts: { transport?: MantleMcpTransport } = {},
): void {
  const transport = opts.transport ?? 'http';
  // Explicit env wins in both directions: =1 opts a network surface in, =0 opts
  // a local one out. Unset means stdio yes, HTTP no.
  const terminalEnv = env('MANTLE_MCP_TERMINAL') ?? '';
  const exposeTerminal = /^(1|true|on|yes)$/i.test(terminalEnv)
    ? true
    : /^(0|false|off|no)$/i.test(terminalEnv)
      ? false
      : transport === 'stdio';
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
          'formula',
          'draw',
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

  // ─── files / folders ──────────────────────────────────────────────────────

  server.tool(
    'folder_create',
    "Create a folder under `parent_path` (ltree, e.g. 'files.work'). Slug must be lowercase + dashes — anything else gets normalised. Description is optional but recommended so future agents know what the folder is for. Creates the directory on disk and the DB row in lockstep. Pass `indexing: 'metadata'` to make it a store-and-share area whose files are indexed by name/type/tags but whose CONTENT is never read into the brain (galleries, temp files, transcription clips).",
    {
      parent_path: z.string().min(1).max(500),
      slug: z.string().min(1).max(64),
      description: z.string().max(2000).optional(),
      indexing: z.enum(['full', 'metadata']).optional(),
    },
    async ({ parent_path, slug, description, indexing }) => {
      await ensureFilesRootBranch(ownerId);
      try {
        const folder = await createFolder({
          ownerId: ownerId,
          parentPath: parent_path,
          slug,
          description,
        });
        // Applied AFTER create so the flag write and the descendant sweep
        // share one code path with the settings toggle.
        if (indexing) {
          await setIndexingMode({ ownerId, nodeId: folder.id, mode: indexing });
        }
        return jsonReply(indexing ? { ...folder, indexing } : folder);
      } catch (err) {
        const msg = errorMessage(err);
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
        const msg = errorMessage(err);
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
    'file_upload',
    "Create or overwrite a file in a folder. Pass either `content_text` (utf-8) or `content_base64` (binary). Filename is lowercased + sanitised. The extractor agent will pick up text files (md/txt/json/yaml) automatically via pg_notify('node_ingested'). Pass `indexing: 'metadata'` to store WITHOUT content indexing (findable by name/type/tags only).",
    {
      parent_path: z.string().min(1).max(500),
      filename: z.string().min(1).max(200),
      content_text: z.string().optional(),
      content_base64: z.string().optional(),
      overwrite: z.boolean().optional(),
      indexing: z.enum(['full', 'metadata']).optional(),
    },
    async ({ parent_path, filename, content_text, content_base64, overwrite, indexing }) => {
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
              text: `file_upload: too large (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB > ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)${MEDIA_EXTS.has(extOf(filename)) ? ' — for video, ingest the link instead (video_ingest)' : ''}`,
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
        // Best-effort ordering: the insert trigger may already have queued
        // extraction, so a full pass CAN race this write. Harmless — the
        // sweep inside setIndexingMode sees applied≠effective and re-queues,
        // and the metadata pass reaps whatever the racing pass wrote.
        if (indexing) {
          await setIndexingMode({ ownerId, nodeId: row.id, mode: indexing });
        }
        return jsonReply(indexing ? { ...row, indexing } : row);
      } catch (err) {
        const msg = errorMessage(err);
        return { content: [{ type: 'text', text: `file_upload failed: ${msg}` }], isError: true };
      }
    },
  );

  // File-manager verbs + the indexing switch: BRIDGED from @mantle/tools so
  // MCP runs the same implementation as in-app agents (same teaching errors,
  // same indexing reconciliation) — hand-written twins rot, see
  // no-duplicate-tools.test.ts.
  registerBuiltinTools(FILE_MANAGE_TOOLS);

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
        const msg = errorMessage(err);
        return { content: [{ type: 'text', text: `file_rename failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'file_delete',
    'Delete a file by id. Removes both the DB row and the on-disk file. If ingest derived nodes from the file (extracted images, imported tables, pages, notes), the call reports their counts instead of deleting; confirm with the user, then call again with delete_derived: true to remove them too.',
    { file_id: z.string().uuid(), delete_derived: z.boolean().optional() },
    async ({ file_id, delete_derived }) => {
      if (delete_derived) {
        const res = await deleteFileWithDerived(ownerId, file_id);
        if (!res.ok) {
          const text =
            res.reason === 'attachment'
              ? "can't delete — this file is an email attachment; delete it from the email instead"
              : res.reason === 'in_drawing'
                ? `can't delete — this image is used in ${(res.drawings ?? []).map((d) => d.title).join(', ') || 'a drawing'}; remove it from the drawing first`
                : 'file not found';
          return { content: [{ type: 'text', text }], isError: true };
        }
        const skipped = res.skipped > 0 ? ` (${res.skipped} derived node(s) skipped)` : '';
        return {
          content: [
            {
              type: 'text',
              text: `deleted, along with ${describeDerivedCounts(res.reaped)} derived from it${skipped}`,
            },
          ],
        };
      }
      const res = await deleteFileById({ ownerId: ownerId, fileId: file_id });
      if (!res.ok) {
        if (res.reason === 'has_derived' && res.derived) {
          // Not an error: a count-and-confirm preview. Nothing was deleted.
          return {
            content: [
              {
                type: 'text',
                text: `this file produced ${describeDerivedCounts(res.derived)} — nothing was deleted; call again with delete_derived: true to remove the file and everything derived from it`,
              },
            ],
          };
        }
        const text =
          res.reason === 'attachment'
            ? "can't delete — this file is an email attachment; delete it from the email instead"
            : res.reason === 'in_drawing'
              ? `can't delete — this image is used in ${(res.drawings ?? []).map((d) => d.title).join(', ') || 'a drawing'}; remove it from the drawing first`
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
    'Approve a queued tool call by id. The handler runs immediately under a fresh `manual` trace; the result is stored on the pending row and returned. For a runner `ask_human` question, approval completes the run step and `answer` carries the free-text reply the run continues with (omit it for a plain yes / option-pick approval). When the row carries a `form` (see its args), answer per sub-question with `answers` instead.',
    {
      id: z.string().uuid(),
      answer: z.string().max(4000).optional(),
      answers: z
        .array(
          z.object({
            question: z.string().max(200).describe("The form question's id, e.g. 'env'"),
            selected: z
              .array(z.string().max(FORM_LIMITS.maxLabelChars))
              .max(FORM_LIMITS.maxOptions)
              .describe('Chosen option labels'),
            other: z
              .string()
              .max(FORM_LIMITS.maxOtherChars)
              .optional()
              .describe('Free text when no option fits'),
          }),
        )
        .max(FORM_LIMITS.maxQuestions)
        .optional()
        .describe("Structured answers, one entry per question in the row's `form`"),
    },
    async ({ id, answer, answers }) => {
      const row = await approvePendingCall(
        ownerId,
        id,
        answer || answers?.length
          ? { ...(answer ? { answer } : {}), ...(answers?.length ? { answers } : {}) }
          : undefined,
      );
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
        const msg = errorMessage(err);
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
        const msg = errorMessage(err);
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

  // ─── Notes / Tasks / Events / Journal / Email / Peers ──────────────────────
  //
  // Content surfaces the assistant can drive. Notes, tasks, events and journal
  // entries are all jsonb on `nodes` (no dedicated tables) and all flow through
  // the extractor for summary + embedding, so semantic search ("what notes do I
  // have about X?") works without explicit indexing here. The journal is the
  // owner's first-person self-knowledge, which feeds the always-on "who you
  // are" context injected into every agent turn — so logging from an MCP client
  // teaches the in-app assistant who the user is.
  //
  // Bridged from the in-app groups rather than hand-wired, so both surfaces run
  // one implementation. That is what gets MCP the things the hand-written
  // twins had drifted away from: ingest provenance on create (the node's
  // biography says an agent made it, instead of "appeared from nowhere"),
  // permalinks and teaching errors on read, and `isError` actually set on a
  // failure rather than a bare "not found" the client reads as success.
  //
  // These groups were once restricted with `only` to the slugs MCP already had,
  // so that bridging stayed a deduplication rather than a widening. The widening
  // has since been made deliberately (see "Full parity" above), so the whole
  // group goes out: note_from_file / note_from_page here, peer_search_chunks and
  // email_send / email_page below.
  registerBuiltinTools(NOTE_TOOLS);
  registerBuiltinTools(TASK_TOOLS);
  registerBuiltinTools(EVENT_TOOLS);

  // ─── Recall — the memory-map system (docs/recall.md) ─────────────────────
  // The tier-1 hook for external agents: these four read-only tools plus the
  // server instructions (MANTLE_MCP_INSTRUCTIONS) are the only surfaces an
  // MCP client auto-loads, so their descriptions carry the "enter the map /
  // match your task" nudge. Serving rows are compiled at page commit; every
  // read here is one indexed row.
  registerBuiltinTools(RECALL_TOOLS);
  registerBuiltinTools(JOURNAL_TOOLS);
  registerBuiltinTools(PEER_TOOLS);
  // Outbound email included: email_send is gated by the contacts allowlist the
  // same way it is for the responder, so the allowlist stays the boundary on
  // every surface rather than the surface being its own second boundary.
  registerBuiltinTools(EMAIL_TOOLS);

  // The one exception: there is no note_delete builtin — the in-app agent
  // cannot delete notes — so MCP's own registration is not a duplicate and
  // stays hand-written.
  server.tool('note_delete', 'Delete a note by id.', { id: z.string() }, async ({ id }) => {
    const ok = await deleteNote(ownerId, id);
    return { content: [{ type: 'text', text: ok ? 'deleted' : 'not found' }] };
  });

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
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
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

  // ─── Draw (read-only) ──────────────────────────────────────────────────────
  // Whiteboard scenes (type='draw'). Read-only over MCP — drawings are
  // authored on the canvas; agents read the committed scene as text (frame
  // headings, shape labels, `A -> B: label` relations). Bridged from the
  // in-app DRAW_TOOLS: same tested handlers, plaintext read shape.
  registerBuiltinTools(DRAW_TOOLS);

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
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
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
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
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

  // ── Federation: query other people's Mantles for data they've shared ─────────
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
   * Scoping: the read-only set (list/get/test/api_key_refs/api_docs_get/
   * web_fetch) is always exposed. The mutating set — authoring
   * (create/update/delete), grouping (tool_group_ensure), the integration
   * writes (api_docs_set / api_skill_set), and granting
   * (agent_grant_tool_group) — is gated on MANTLE_MCP_TOOLSMITH_WRITE,
   * which defaults ON. Set it to
   * 0/false/off on a shared or headless deployment to expose Toolsmith
   * read-only while keeping tool authoring + granting to the in-app agent.
   */

  /** Convert one JSON-Schema property def into a zod type. Honors `items` for
   *  arrays, `integer` (vs number), nested object `properties`, `[T,'null']`
   *  nullable unions, and the size bounds (`minLength`/`maxLength`,
   *  `minimum`/`maximum`, `minItems`/`maxItems`) — so validation isn't silently
   *  dropped if a def grows past the original string/number/boolean/array
   *  vocabulary.
   *
   *  The bounds matter as much as the types: `validate-args` enforces them for
   *  the in-app agent, so dropping them here would leave the MCP surface the
   *  only one that accepts a 10 000-character title. */
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
    const bound = (key: string): number | undefined =>
      typeof def[key] === 'number' ? (def[key] as number) : undefined;
    /** Apply a `[min, max]` pair, skipping the ends the schema left open. */
    const bounded = <T extends { min(n: number): T; max(n: number): T }>(
      t: T,
      minKey: string,
      maxKey: string,
    ): T => {
      const min = bound(minKey);
      const max = bound(maxKey);
      let out = t;
      if (min !== undefined) out = out.min(min);
      if (max !== undefined) out = out.max(max);
      return out;
    };
    switch (type) {
      case 'string':
        return bounded(z.string(), 'minLength', 'maxLength');
      case 'number':
        return bounded(z.number(), 'minimum', 'maximum');
      case 'integer':
        return bounded(z.number().int(), 'minimum', 'maximum');
      case 'boolean':
        return z.boolean();
      case 'array': {
        const items = (def.items ?? {}) as Record<string, unknown>;
        const inner = 'type' in items || 'enum' in items ? zodForDef(items) : z.unknown();
        return bounded(z.array(inner), 'minItems', 'maxItems');
      }
      case 'object': {
        const props = (def.properties ?? {}) as Record<string, Record<string, unknown>>;
        // zod 4 requires the key type explicitly (`z.record(z.string(), z.unknown())` was
        // zod 3). JSON object keys are always strings, so this is the same shape.
        if (Object.keys(props).length === 0) return z.record(z.string(), z.unknown());
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
   *  surface the node id in `output`.
   *
   *  `opts.skip` gates a def out; `opts.only` restricts to an explicit slug set,
   *  which is how a group is bridged for DEDUPLICATION without also widening the
   *  MCP surface with its other members. */
  function registerBuiltinTools(
    defs: readonly BuiltinToolDef[],
    opts?: { skip?: (def: BuiltinToolDef) => boolean; only?: ReadonlySet<string> },
  ) {
    for (const def of defs) {
      if (opts?.only && !opts.only.has(def.slug)) continue;
      if (opts?.skip?.(def)) continue;
      server.tool(
        def.slug,
        def.description,
        zodShapeFromJsonSchema(def.inputSchema),
        async (args: Record<string, unknown>) => {
          const input = args ?? {};
          // Declared referential preconditions run first, exactly as
          // dispatch.ts does for the in-app agent. Without this the MCP surface
          // is the only one where an id pointing at a missing — or wrong-type —
          // node reaches the handler and comes back as a bare "not found",
          // hiding the actual mistake.
          if (def.preconditions?.length) {
            const failure = await checkToolPreconditions(def.preconditions, input, ownerId);
            if (failure && !failure.ok) {
              return {
                content: [{ type: 'text' as const, text: `Error: ${failure.error}` }],
                isError: true,
              };
            }
          }
          const result = await def.handler(input, { ownerId: ownerId });
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
  /** Shared handler for `ask_responder` and its deprecated alias. */
  async function askResponder(a: {
    message: string;
    agent_slug?: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
    exclude_tools?: string[];
    read_only?: boolean;
    max_iterations?: number;
    include_tool_calls?: boolean;
    toolName: string;
  }) {
    // Cap the caller-held transcript before it reaches the model — an
    // unbounded resend would blow the context budget. Reject with a corrective
    // (say the limit + the fix) rather than silently truncating history.
    if (a.message.length > SIM_MAX_CONTENT) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${a.toolName}: message is ${a.message.length} chars (max ${SIM_MAX_CONTENT}) — ` +
              'shorten it, or put the bulk in a file/page and reference it.',
          },
        ],
        isError: true,
      };
    }
    if (a.history && a.history.length > SIM_MAX_HISTORY) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${a.toolName}: history has ${a.history.length} turns (max ${SIM_MAX_HISTORY}) — ` +
              'drop the oldest turns and resend, or start a fresh transcript.',
          },
        ],
        isError: true,
      };
    }
    const tooLong = (a.history ?? []).findIndex((t) => t.content.length > SIM_MAX_CONTENT);
    if (tooLong >= 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${a.toolName}: history entry ${tooLong} is ${a.history![tooLong]!.content.length} ` +
              `chars (max ${SIM_MAX_CONTENT}) — shorten or summarise that turn and resend.`,
          },
        ],
        isError: true,
      };
    }
    try {
      const res = await runSimulatedResponderTurn(ownerId, {
        message: a.message,
        ...(a.agent_slug ? { agentSlug: a.agent_slug } : {}),
        ...(a.history ? { history: a.history } : {}),
        ...(a.exclude_tools ? { excludeToolSlugs: a.exclude_tools } : {}),
        ...(a.read_only ? { readOnly: true } : {}),
        ...(typeof a.max_iterations === 'number' ? { maxIterations: a.max_iterations } : {}),
      });
      const withCalls = a.include_tool_calls !== false;
      return jsonReply({
        reply: res.reply,
        agent: res.agent,
        read_only: a.read_only === true,
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
      const msg = errorMessage(err);
      return {
        content: [{ type: 'text' as const, text: `${a.toolName} failed: ${msg}` }],
        isError: true,
      };
    }
  }

  const ASK_RESPONDER_SCHEMA = {
    message: z.string().min(1),
    agent_slug: z.string().optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .optional(),
    exclude_tools: z.array(z.string()).optional(),
    read_only: z.boolean().optional(),
    max_iterations: z.number().int().min(1).max(30).optional(),
    include_tool_calls: z.boolean().optional(),
  };

  server.tool(
    'ask_responder',
    "Ask one of the user's responder agents a question and get ITS answer, routed through " +
      'its own persona, memory and tools. Runs ONE real turn server-side: composed persona ' +
      '(identity + skills), real retrieval, real granted tools, real delegation — with every ' +
      "guard and confirm-gate ENFORCED. Writes nothing to the agent's conversation history, " +
      "so it's safe to probe repeatedly. **Tools EXECUTE by default: side effects happen and " +
      'confirm-gated calls land on /pending (`pending_ids`). Pass `read_only` for a probe that ' +
      'cannot write or send anything** — the right default for a post-deploy canary. Multi-turn ' +
      'is caller-held: keep the transcript and resend it in `history`. Omit `agent_slug` for the ' +
      'default responder. To answer AS the responder in your own loop instead, use ' +
      '`ask_as_responder`.',
    ASK_RESPONDER_SCHEMA,
    async (a) => askResponder({ ...a, toolName: 'ask_responder' }),
  );

  server.tool(
    'ask_as_responder',
    "Adopt a responder's persona and answer as it YOURSELF, in your own loop. Returns the " +
      'composed system prompt (identity + skills + house style), the skill list, the tool slugs ' +
      'it would hold and its delegation edges — no model call, no tool run, nothing written. ' +
      'Use when you want to sound and reason like the responder across a long stretch of your ' +
      'own work. **What comes back is teaching, NOT permission: nothing here constrains you.** ' +
      '`delegate_to` is a list rather than a gate, `tool_slugs` is what the responder would be ' +
      'granted rather than what you can call, and confirm-gating, /pending parking and the loop ' +
      'guards stay on the server. When the rules must actually be enforced, use `ask_responder` ' +
      'and let the brain run the turn. Pass `read_only` to see the narrowed tool list a ' +
      'read-only probe would get.',
    {
      agent_slug: z.string().optional(),
      read_only: z.boolean().optional(),
    },
    async ({ agent_slug, read_only }) => {
      try {
        const p = await describeResponderPersona(ownerId, {
          ...(agent_slug ? { agentSlug: agent_slug } : {}),
          ...(read_only ? { readOnly: true } : {}),
        });
        return jsonReply({
          agent: p.agent,
          system_prompt: p.systemPrompt,
          skills: p.skills,
          tool_slugs: p.toolSlugs,
          delegate_to: p.delegateTo,
          read_only: p.readOnly,
          advisory: p.advisory,
        });
      } catch (err) {
        const msg = errorMessage(err);
        return {
          content: [{ type: 'text' as const, text: `ask_as_responder failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Export (Word / Excel) ───────────────────────────────────────────────────
  // Renders a page/note → .docx or a table → .xlsx into /files/exports and returns
  // the new file's id/path. Pure (no surface, no artifact) — bridges as-is.
  registerBuiltinTools(EXPORT_TOOLS);

  // ─── Spreadsheet authoring ───────────────────────────────────────────────────
  // `sheet_build` composes a formatted .xlsx from data the client already holds
  // and saves it under /files. Belongs on this surface for the same reason
  // `export_node` does: an MCP client is often the one holding the numbers (a
  // Claude Desktop session working through a costing) and wants a file back.
  // Pure — writes one file node, no surface, no artifact.
  registerBuiltinTools(SHEET_TOOLS);

  // ─── Apps (mini-app builder) ──────────────────────────────────────────────────
  // Author Mantle mini-apps end-to-end from an MCP client: create, write the TSX
  // source tree (app_file_write per file or app_source_set for the whole tree at
  // once), declare the data tools the app may broker (app_tools_set) + per-app
  // SQLite schema (app_db_schema_set), compile server-side via esbuild (app_build
  // returns file/line/column diagnostics to iterate on), preview, and publish.
  // The app reaches owner data only through its declared tool allowlist — pair
  // this with the Toolsmith tools below to mint the data-access tools an app needs.
  registerBuiltinTools(APP_TOOLS);

  // ─── CLI sandboxes ────────────────────────────────────────────────────────────
  // Isolated Ubuntu containers the client can work in: clone a repo and explain
  // it, evaluate a package, build and run a small service. This is the ONE place
  // an MCP client gets command execution, and it is deliberately the contained
  // one: `run_terminal` (the brain's own shell) stays off this surface, while
  // `sandbox_exec` runs inside a container on an egress-only network with no
  // route to postgres, minio or the web tier (docs/sandboxes.md).
  //
  // Bridged unconditionally, exactly as the in-app coder agent holds them: the
  // handlers already answer "sandboxes are not enabled on this box" when the
  // `sandboxes` compose profile is off, so a box without sandboxd gives the
  // client a clear reason instead of a missing tool it cannot ask about.
  registerBuiltinTools(SANDBOX_TOOLS);

  // ─── Full parity: the rest of the in-app catalog ─────────────────────────────
  // Everything below was agent-only until the parity rule above. Grouped by what
  // it does, with a note only where the exposure is worth a second thought.

  // Reads. node_read fetches any node by id (the typed getters cover one type
  // each); brain_capacity is the corpus-vs-split-policy self-check.
  registerBuiltinTools(NODE_READ_TOOLS);
  // 2026-09-02 (audit): the search / entity / file-read / telegram groups now
  // exist in @mantle/tools, so their MCP twins are bridged from the one tested
  // handler each. Deliberately still hand-written (read-shape divergence, or
  // a schema MCP clients already depend on): `search` (search_nodes under its
  // shipped name), tree_list, file_get/file_read/file_rename (id vs file_id),
  // folder_describe/folder_rename (accept a path as well as an id).
  registerBuiltinTools(SEARCH_TOOLS, {
    skip: (def) => def.slug === 'search_nodes' || def.slug === 'tree_list',
  });
  registerBuiltinTools(ENTITY_TOOLS);
  registerBuiltinTools(FILE_TOOLS, { only: new Set(['folder_list', 'file_list']) });
  registerBuiltinTools(TELEGRAM_TOOLS);
  registerBuiltinTools(TOOL_RESULT_TOOLS);
  registerBuiltinTools(IMAGE_TOOLS);
  registerBuiltinTools(APP_DATA_TOOLS);

  // Pure computation — no I/O, no spend.
  registerBuiltinTools(CALCULATE_TOOLS);
  registerBuiltinTools(FORMULA_TOOLS);

  // Files: create-from-text and resolve-a-folder-by-path, the two the
  // hand-written file surface never had.
  registerBuiltinTools(FILE_CREATE_TOOLS);

  // Content lifecycle. content_supersede down-weights, never deletes;
  // process_extraction spends model budget, which is the point of asking for it.
  registerBuiltinTools(CONTENT_CURATION_TOOLS);
  registerBuiltinTools(INGEST_TOOLS);

  // Replay reads the owner's OWN past conversations. Private, but the caller is
  // the authenticated owner — the same person those conversations belong to.
  registerBuiltinTools(REPLAY_TOOLS);

  // Owner-side Team Chat: read members, threads and the access log, and file a
  // member-to-member notification. This is the OWNER's view over the team
  // surface, never the team responder's own tools.
  registerBuiltinTools(TEAM_TOOLS);

  // Outbound and spend. web_search / video_ingest / web_map / web_crawl all
  // reach the open internet and bill the owner's keys, so they are real actions
  // rather than reads — exposed because a client asked to research something
  // should be able to, and refusing quietly is worse than spending on request.
  registerBuiltinTools(RESEARCH_TOOLS);
  registerBuiltinTools(VIDEO_TOOLS);
  registerBuiltinTools(CRAWL_TOOLS);
  registerBuiltinTools(LOCATION_TOOLS);

  // Owner state: persona calibration, timezone, stored credentials.
  registerBuiltinTools(PERSONA_TOOLS);
  registerBuiltinTools(PROFILE_TOOLS);
  registerBuiltinTools(SECRET_TOOLS);

  // node_share PUBLISHES outward (mints a public link). It is confirm-gated in
  // the in-app loop and keeps that gate here — the bridge runs the same def.
  registerBuiltinTools(SHARE_TOOLS);

  // Delegation + durable runs. invoke_agent hands work to an in-brain
  // specialist; the run tools plan and drive background queues (creation is
  // additionally gated by MANTLE_RUNS on the box, docs/runs.md).
  registerBuiltinTools(DELEGATION_TOOLS);
  registerBuiltinTools(RUN_TOOLS);

  // Model curation (OpenRouter reads + the curated pools) and the retrieval
  // eval. recall_eval embeds a query set, so it costs — advisory tools, none of
  // which change what any agent actually runs.
  registerBuiltinTools(CURATION_TOOLS);
  registerBuiltinTools(EVAL_TOOLS);

  // ─── The brain's own shell ────────────────────────────────────────────────────
  // The one transport-dependent tool on this surface. See the file header: over
  // stdio it grants nothing that spawning the process did not already grant;
  // over HTTP it turns a stolen bearer into a root shell on the box, so it needs
  // MANTLE_MCP_TERMINAL=1. `sandbox_exec` above is the contained alternative and
  // is always available.
  if (exposeTerminal) registerBuiltinTools(TERMINAL_TOOLS);

  // ─── Toolsmith ───────────────────────────────────────────────────────────────
  // Writes gated behind MANTLE_MCP_TOOLSMITH_WRITE (see TOOLSMITH_WRITE_SLUGS).
  registerBuiltinTools(TOOLSMITH_TOOLS, {
    skip: (def) => !toolsmithWriteEnabled && TOOLSMITH_WRITE_SLUGS.has(def.slug),
  });
}

/** What every connecting MCP client auto-loads alongside the tool list — the
 *  ONLY automatic surface the protocol gives a server, so it carries Recall's
 *  tier-1 hook (docs/recall.md §"Automatic, honestly bounded"). Static by
 *  design: the live catalog is one cheap `recall_index` call away, and a
 *  static string can never go stale against it. */
export const MANTLE_MCP_INSTRUCTIONS = [
  'This brain carries Recall: owner-authored memory maps and prompts for agents.',
  'Before starting a distinct task, call recall_match with one line describing it and apply a strong match.',
  'When working in a domain the owner has mapped, recall_index lists the maps — recall_open the relevant one and follow its options instead of searching blind.',
  "Pass intent= on recall_* calls (one line on why you came) so the owner's recall log can show it.",
].join(' ');

/** Create a fresh `McpServer` with the full Mantle tool surface, scoped to
 *  `ownerId`. This is the STDIO entry's builder — no port, no token, spawned by
 *  a client on a machine the owner controls — so it registers the stdio
 *  posture. The HTTP route registers onto the adapter-provided server via
 *  `registerMantleTools` with `transport: 'http'`. */
export function buildMantleMcpServer(ownerId: string): McpServer {
  const server = new McpServer(
    { name: 'mantle', version: '0.0.1' },
    { instructions: MANTLE_MCP_INSTRUCTIONS },
  );
  registerMantleTools(server, ownerId, { transport: 'stdio' });
  return server;
}
