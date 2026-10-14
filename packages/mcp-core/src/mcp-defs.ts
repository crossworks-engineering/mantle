/**
 * The hand-written MCP tools as definitions (workspaces arch plan v2,
 * sections 8 and 23.3, A5 step 2): the sixteen tools the owner MCP surface
 * registers itself rather than bridging a builtin, each with its policy
 * (a ToolPolicy, required, as on every builtin), its group (where in the
 * surface's order it registers) and its body, moved here as it was.
 * Registration reads this table (registerMcpTools, from register/*.ts), and
 * the surface's own lists are views of it and of the builtin policy table
 * (mcp-policy.ts).
 *
 * Each definition takes its policy by its name from @mantle/tools
 * mcp-surface-policies.ts (fix round 1, LOW-1): that leaf is the surface
 * table every process loads, so the Admin gate knows the two responder
 * tools that write into the owner's conversation (ADMIN_ONLY_TOOL_SLUGS)
 * with or without this package loaded. A name here with no policy there
 * does not type-check; mcp-defs.test.ts pins that the two hold the same
 * names.
 *
 * Eleven share a name with a builtin and keep their own schema and reply
 * shape (no-duplicate-tools.test.ts says why); their policy is the
 * builtin's (mcp-defs.test.ts pins it). The other five are MCP's own:
 * `search` (the surface's name for search_nodes) and the four responder
 * tools.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import {
  MCP_SURFACE_POLICIES,
  SEARCH_TOOLS,
  thrownToolDatabaseError,
  toolItemWriteRefusal,
  type BuiltinToolDef,
  type McpSurfaceSlug,
  type SurfaceToolDef,
} from '@mantle/tools';
import {
  getPage,
  getTable,
  listPages,
  listRows,
  listTables,
  ensureTableDoc,
} from '@mantle/content';
import {
  fileById,
  folderByPath,
  readFileById,
  renameFileById,
  renameFolderById,
  updateFolderDescription,
} from '@mantle/files';
import {
  describeResponderPersona,
  describeResponderTurnInput,
  recordMcpResponderTurn,
  runSimulatedResponderTurn,
} from '@mantle/runtime/assistant';
import { errorMessage } from '@mantle/std';
import type { McpRegisterContext } from './register/context';

/** Where in the surface's order a definition registers (build-server.ts
 *  calls each group's registrar at its place). */
export type McpToolGroup = 'search' | 'folders' | 'files' | 'pages' | 'tables' | 'responder';

/** One hand-written MCP tool. */
export type McpToolDef = SurfaceToolDef &
  Readonly<{
    group: McpToolGroup;
    description: string;
    /** Its arguments, as the zod raw shape the surface advertises. */
    shape: z.ZodRawShape;
    /** Register it on the context's server (its body, bound to the
     *  connection). */
    register: (ctx: McpRegisterContext) => void;
  }>;

/** A definition, typed by its own shape, with the policy its name has
 *  (MCP_SURFACE_POLICIES). */
function mcpTool<S extends z.ZodRawShape>(def: {
  slug: McpSurfaceSlug;
  group: McpToolGroup;
  description: string;
  shape: S;
  /** The body: the handler for one connection (its validated arguments;
   *  the reply). */
  handler: (ctx: McpRegisterContext) => (args: z.output<z.ZodObject<S>>) => Promise<unknown>;
}): McpToolDef {
  const { handler, ...rest } = def;
  return Object.freeze({
    ...rest,
    policy: MCP_SURFACE_POLICIES[def.slug],
    // Registered through the one gate (gated-tools.ts, A5 step 4): listed
    // as the gate lists it, each call its body inside enterCall.
    register: (ctx: McpRegisterContext) =>
      ctx.registerDefinition(
        def.slug,
        def.description,
        def.shape,
        handler(ctx) as (args: Record<string, unknown>) => Promise<unknown>,
      ),
  });
}

// ── search ──────────────────────────────────────────────────────────────────

/**
 * `tree_list` stays hand-written: its MCP schema (an optional `path`) is not
 * the builtin's, and renaming arguments under shipped connectors is not worth
 * the dedupe. See no-duplicate-tools.test.ts.
 */
const TREE_LIST = mcpTool({
  slug: 'tree_list',
  group: 'search',
  description: 'List children of a branch in the Mantle tree. Pass no path for top-level branches.',
  shape: { path: z.string().optional() },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ path }) => {
      const rows = await db
        .select({ id: nodes.id, title: nodes.title, type: nodes.type, path: nodes.path })
        .from(nodes)
        .where(
          and(eq(nodes.ownerId, ownerId), path ? eq(nodes.path, path) : eq(nodes.type, 'branch')),
        )
        .limit(200);
      return jsonReply(rows);
    };
  },
});

/** The builtin `search` runs. Resolved from the group rather than imported
 *  directly, so it stays tied to the set build-server.ts skips it from: if the
 *  slug ever leaves SEARCH_TOOLS, registration fails loudly here instead of
 *  quietly handing MCP an undefined handler. */
function searchNodesBuiltin(): BuiltinToolDef {
  const def = SEARCH_TOOLS.find((t) => t.slug === 'search_nodes');
  if (!def)
    throw new Error(
      'search_nodes is no longer in SEARCH_TOOLS — MCP `search` has no implementation',
    );
  return def;
}

/**
 * `search` was a 63-line FORK of the `search_nodes` builtin, and it survived
 * every duplicate check we had for one reason: the MCP surface calls it
 * `search` while the builtin is `search_nodes`, so a slug comparison never saw
 * two implementations of the same thing. It had drifted the way forks do —
 * silently, and only in the direction of being worse:
 *
 *   · no `url` permalink on a hit, so a client could not link one
 *   · NO supersession annotation at all, so a stale copy came back looking
 *     current while the in-app agent got "prefer this successor" on the same
 *     row. That is the content-currency machinery the whole retrieval layer is
 *     built around, absent on the surface Claude Desktop actually uses.
 *   · a thrown error instead of an `isError` reply
 *   · `journal` missing from its type filter
 *
 * It now runs the builtin, through `callBuiltin`: dispatch and the one gate,
 * nested in its own call (A5 step 4). The MCP-facing NAME, description and argument names are kept
 * exactly, because connectors depend on them; the reply gains `url` and
 * `superseded_by`, which is additive.
 */
const SEARCH = mcpTool({
  slug: 'search',
  group: 'search',
  description:
    "Hybrid semantic + full-text search over the user's Mantle — ranks by meaning (vector) with keyword as a booster, so vague/natural queries work, not just exact words. Use `branch` (ltree path) to scope, `type` to filter. Returns the spine (title, tags, summary) — use node_read / file_read / email_get for a full body.",
  shape: {
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
        'journal',
        'formula',
        'draw',
      ])
      .optional(),
    tags: z.array(z.string()).optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  handler: (ctx) => {
    const { callBuiltin } = ctx;
    const search_nodes = searchNodesBuiltin();
    return async ({ q, branch, type, tags, since, limit }) =>
      callBuiltin(search_nodes, { q, branch, type, tags, since, limit });
  },
});

// ── files and folders ───────────────────────────────────────────────────────
// The hand-written verbs stay hand-written because their MCP argument names
// differ from the builtin's (id vs file_id, path vs folder id) and renaming
// them would break shipped connectors.

const FOLDER_DESCRIBE = mcpTool({
  slug: 'folder_describe',
  group: 'folders',
  description:
    "Set or clear a folder's description. Useful for agents that just created a folder and want to document what goes in it.",
  shape: {
    folder_id: z.string().uuid().optional(),
    path: z.string().optional(),
    description: z.string().max(2000),
  },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ folder_id, path, description }) => {
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
      // The folder found by its path is checked as an id is (W7a fix round
      // 1, M2): the scope may edit it.
      const refused = await toolItemWriteRefusal('folder_describe', { folder_id: id }, ownerId);
      if (refused) return { content: [{ type: 'text', text: `Error: ${refused}` }], isError: true };
      const updated = await updateFolderDescription({
        ownerId: ownerId,
        folderId: id,
        description,
      });
      if (!updated) {
        return { content: [{ type: 'text', text: 'folder not found' }], isError: true };
      }
      return jsonReply(updated);
    };
  },
});

const FOLDER_RENAME = mcpTool({
  slug: 'folder_rename',
  group: 'folders',
  description:
    'Rename a folder in place. `new_name` is lowercased + sanitised. Every file and sub-folder inside moves with it (their paths update). Pass `folder_id` or `path`. Cannot rename the `files` root.',
  shape: {
    folder_id: z.string().uuid().optional(),
    path: z.string().optional(),
    new_name: z.string().min(1).max(64),
  },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ folder_id, path, new_name }) => {
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
      // The folder found by its path is checked as an id is (W7a fix round
      // 1, M2): the scope may edit it.
      const refused = await toolItemWriteRefusal('folder_rename', { folder_id: id }, ownerId);
      if (refused) return { content: [{ type: 'text', text: `Error: ${refused}` }], isError: true };
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
        // A database error is never its text (W3; A5 step 4 fix round 1):
        // the one mapper's words, as a thrown one is answered.
        const msg = thrownToolDatabaseError('mcp folder_rename', err) ?? errorMessage(err);
        return { content: [{ type: 'text', text: `folder_rename failed: ${msg}` }], isError: true };
      }
    };
  },
});

const FILE_READ = mcpTool({
  slug: 'file_read',
  group: 'files',
  description:
    'Read a file by id. For text files returns the content as a utf-8 string; for binaries returns base64-encoded bytes (only call this on small files).',
  shape: { file_id: z.string().uuid() },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ file_id }) => {
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
    };
  },
});

const FILE_GET = mcpTool({
  slug: 'file_get',
  group: 'files',
  description:
    "Fetch a file's metadata by id without loading bytes. Useful for resolving a uuid surfaced by search before deciding what to do with it.",
  shape: { file_id: z.string().uuid() },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ file_id }) => {
      const row = await fileById({ ownerId: ownerId, fileId: file_id });
      if (!row) {
        return { content: [{ type: 'text', text: 'file not found' }], isError: true };
      }
      return jsonReply(row);
    };
  },
});

const FILE_RENAME = mcpTool({
  slug: 'file_rename',
  group: 'files',
  description:
    'Rename a file in place — its folder and extension are kept, only the basename changes. `new_stem` is the new name WITHOUT the extension (e.g. `huntsman-report` → `customerx-report`).',
  shape: { file_id: z.string().uuid(), new_stem: z.string().min(1).max(200) },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ file_id, new_stem }) => {
      const refused = await toolItemWriteRefusal('file_rename', { file_id }, ownerId);
      if (refused) return { content: [{ type: 'text', text: `Error: ${refused}` }], isError: true };
      try {
        const row = await renameFileById({ ownerId: ownerId, fileId: file_id, newStem: new_stem });
        if (!row) {
          return { content: [{ type: 'text', text: 'file not found' }], isError: true };
        }
        return jsonReply(row);
      } catch (err) {
        // A database error is never its text (W3; A5 step 4 fix round 1):
        // the one mapper's words, as a thrown one is answered.
        const msg = thrownToolDatabaseError('mcp file_rename', err) ?? errorMessage(err);
        return { content: [{ type: 'text', text: `file_rename failed: ${msg}` }], isError: true };
      }
    };
  },
});

// ── pages (read-only) ───────────────────────────────────────────────────────
// Rich TipTap documents (type='page'). Read-only over MCP for now — pages are
// authored in the web editor; the assistant finds and reads them. page_list
// omits the document body; page_get returns the full ProseMirror JSON. The
// builtin read tools return plaintext + block ids, left as the read path for
// the in-app agent to avoid changing the existing MCP read shape.

const PAGE_LIST = mcpTool({
  slug: 'page_list',
  group: 'pages',
  description:
    "List the owner's pages. Optional `query` substring-matches title/body/summary; `tag` filters to pages carrying that tag. Bodies are omitted — use page_get for the full document.",
  shape: {
    query: z.string().optional(),
    tag: z.string().optional(),
  },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ query, tag }) => {
      const rows = await listPages(ownerId, { query, tag });
      return jsonReply(rows);
    };
  },
});

const PAGE_GET = mcpTool({
  slug: 'page_get',
  group: 'pages',
  description: 'Get a single page by id, including its full ProseMirror/TipTap document.',
  shape: { id: z.string() },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ id }) => {
      const row = await getPage(ownerId, id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      return jsonReply(row);
    };
  },
});

// ── tables (read-only) ──────────────────────────────────────────────────────
// Typed database grids (type='table'). Read-only over MCP — tables are authored
// in the web grid editor + by the Tables agent. table_list omits the grid;
// table_get returns columns + a row window; table_rows_list is the addressable
// row snapshot.

const TABLE_LIST = mcpTool({
  slug: 'table_list',
  group: 'tables',
  description:
    "List the owner's tables. Optional `query` substring-matches title/body/summary; `tag` filters. Grids are summarised (column + row counts) — use table_get for content.",
  shape: {
    query: z.string().optional(),
    tag: z.string().optional(),
  },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ query, tag }) => {
      const rows = await listTables(ownerId, { query, tag });
      return jsonReply(rows);
    };
  },
});

const TABLE_GET = mcpTool({
  slug: 'table_get',
  group: 'tables',
  description:
    'Get a single table by id: its columns and a window of rows (formula columns resolved). `offset`/`limit` page large grids.',
  shape: { id: z.string(), offset: z.number().optional(), limit: z.number().optional() },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ id, offset, limit }) => {
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
    };
  },
});

const TABLE_ROWS_LIST = mcpTool({
  slug: 'table_rows_list',
  group: 'tables',
  description:
    "Windowed snapshot of a table's rows — each a stable id + short per-cell text. Page via offset/limit.",
  shape: { table_id: z.string(), offset: z.number().optional(), limit: z.number().optional() },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ table_id, offset, limit }) => {
      const row = await getTable(ownerId, table_id);
      if (!row) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      const listed = listRows(ensureTableDoc(row.data), {
        offset: offset ?? 0,
        limit: limit ?? 50,
      });
      return jsonReply(listed);
    };
  },
});

// ── responder ───────────────────────────────────────────────────────────────
// Responder simulation: the real pipeline (persona, retrieval, real tool
// execution) with nothing persisted to the conversation store. Plus the one
// opt-in write: `responder_turn_record`, which keeps a turn the client
// answered as the agent.

/**
 * Whose thread these tools read and write (W7c fix round 1, M1): the
 * connection's own login. The anchor only on its own stdio (which names no
 * login); any other connection that names none (a peer the owner did not
 * register) gets null and the call is refused, never the anchor's thread.
 */
function threadLoginOf(ctx: McpRegisterContext): string | null {
  return ctx.loginId ?? (ctx.transport === 'stdio' ? ctx.ownerId : null);
}

const NO_LOGIN = {
  content: [
    {
      type: 'text' as const,
      text: 'Error: this connection names no login, so it has no chat thread of its own.',
    },
  ],
  isError: true,
};

// Talk to a responder agent over MCP with the REAL pipeline (persona +
// retrieval + real tool execution) but NOTHING persisted to its conversation
// store. Input caps mirror the web Studio sandbox (40 turns, 8000 chars each).
const SIM_MAX_HISTORY = 40;
const SIM_MAX_CONTENT = 8000;
const SIM_ARGS_CLIP = 500;

/** Cap the caller-held transcript before it reaches the model: an
 *  unbounded resend would blow the context budget. Reject with a corrective
 *  (say the limit + the fix) rather than silently truncating history. Shared
 *  by every tool that takes a caller-held transcript. */
function checkSimInputCaps(a: {
  message: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  toolName: string;
}) {
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
  return null;
}

/** The handler of `ask_responder`. */
async function askResponder(
  ctx: McpRegisterContext,
  a: {
    message: string;
    agent_slug?: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
    exclude_tools?: string[];
    read_only?: boolean;
    max_iterations?: number;
    include_tool_calls?: boolean;
    toolName: string;
  },
) {
  const { ownerId, jsonReply } = ctx;
  const threadLogin = threadLoginOf(ctx);
  const capError = checkSimInputCaps(a);
  if (capError) return capError;
  if (!threadLogin) return NO_LOGIN;
  try {
    const res = await runSimulatedResponderTurn(ownerId, {
      loginId: threadLogin,
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
    const msg = thrownToolDatabaseError(`mcp ${a.toolName}`, err) ?? errorMessage(err);
    return {
      content: [{ type: 'text' as const, text: `${a.toolName} failed: ${msg}` }],
      isError: true,
    };
  }
}

const ASK_RESPONDER = mcpTool({
  slug: 'ask_responder',
  group: 'responder',
  description:
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
  shape: {
    message: z.string().min(1),
    agent_slug: z.string().optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .optional(),
    exclude_tools: z.array(z.string()).optional(),
    read_only: z.boolean().optional(),
    max_iterations: z.number().int().min(1).max(30).optional(),
    include_tool_calls: z.boolean().optional(),
  },
  handler: (ctx) => async (a) => askResponder(ctx, { ...a, toolName: 'ask_responder' }),
});

const ASK_AS_RESPONDER = mcpTool({
  slug: 'ask_as_responder',
  group: 'responder',
  description:
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
  shape: {
    agent_slug: z.string().optional(),
    read_only: z.boolean().optional(),
  },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    return async ({ agent_slug, read_only }) => {
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
        const msg = thrownToolDatabaseError('mcp ask_as_responder', err) ?? errorMessage(err);
        return {
          content: [{ type: 'text' as const, text: `ask_as_responder failed: ${msg}` }],
          isError: true,
        };
      }
    };
  },
});

const RESPONDER_TURN_INPUT = mcpTool({
  slug: 'responder_turn_input',
  group: 'responder',
  description:
    "Get the exact INPUT one of the user's responder agents would get for a message, so YOUR " +
    'model can answer it as that agent: the composed system prompt, the retrieval context for ' +
    'this message (facts, passages, digests, corpus map), the history as it would be sent, and ' +
    'the tool schemas as the agent sees them. No model call, no tool run, nothing written to ' +
    'the conversation (one trace holds the retrieval snapshot: `trace_id`). Runs the same read ' +
    'path as `ask_responder`, so the two see the same turn. Multi-turn is caller-held: resend ' +
    'your transcript in `history`. To skip resending what does not change per message, pass ' +
    '`omit_cached` (drops the cached prefix blocks) and `tools: "names"` or `"none"` after the ' +
    'first call. Tools default to `brief` (name + first sentence): a big responder holds 140+ ' +
    'tools and their full schemas run past 150k characters, so fetch the full schema of only the ' +
    'tools you mean to call with `schemas_for`, or pass `tools: "full"`. **Input, not enforcement:** your tools run on this MCP surface, not in the ' +
    'agent loop, so its guards and confirm gates do not apply. `differences` lists what else ' +
    'differs. Use `ask_responder` when the agent itself must answer.',
  shape: {
    message: z.string().min(1),
    agent_slug: z.string().optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
      .optional(),
    exclude_tools: z.array(z.string()).optional(),
    read_only: z.boolean().optional(),
    tools: z.enum(['full', 'brief', 'names', 'none']).optional(),
    schemas_for: z.array(z.string()).optional(),
    omit_cached: z.boolean().optional(),
  },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    const threadLogin = threadLoginOf(ctx);
    return async (a) => {
      const capError = checkSimInputCaps({ ...a, toolName: 'responder_turn_input' });
      if (capError) return capError;
      if (!threadLogin) return NO_LOGIN;
      try {
        const res = await describeResponderTurnInput(ownerId, {
          loginId: threadLogin,
          message: a.message,
          ...(a.agent_slug ? { agentSlug: a.agent_slug } : {}),
          ...(a.history ? { history: a.history } : {}),
          ...(a.exclude_tools ? { excludeToolSlugs: a.exclude_tools } : {}),
          ...(a.read_only ? { readOnly: true } : {}),
        });
        const toolDetail = a.tools ?? 'brief';
        const messages = a.omit_cached ? res.messages.filter((m) => !m.cached) : res.messages;
        const wanted = new Set(a.schemas_for ?? []);
        return jsonReply({
          agent: res.agent,
          read_only: res.readOnly,
          ...(a.omit_cached
            ? { omitted_cached_blocks: res.messages.length - messages.length }
            : {}),
          messages,
          ...(toolDetail === 'full'
            ? { tools: res.tools }
            : toolDetail === 'brief'
              ? {
                  tools: res.tools.map((t) => ({
                    name: t.name,
                    about: firstSentence(t.description),
                  })),
                }
              : toolDetail === 'names'
                ? { tool_names: res.tools.map((t) => t.name) }
                : { tool_count: res.tools.length }),
          ...(wanted.size > 0 ? { schemas: res.tools.filter((t) => wanted.has(t.name)) } : {}),
          loop: res.loop,
          context: res.context,
          trace_id: res.traceId,
          differences: res.differences,
        });
      } catch (err) {
        const msg = thrownToolDatabaseError('mcp responder_turn_input', err) ?? errorMessage(err);
        return {
          content: [{ type: 'text' as const, text: `responder_turn_input failed: ${msg}` }],
          isError: true,
        };
      }
    };
  },
});

const RESPONDER_TURN_RECORD = mcpTool({
  slug: 'responder_turn_record',
  group: 'responder',
  description:
    "WRITE a turn you answered AS one of the user's responder agents into that agent's " +
    'conversation, so it shows in the Assistant window as if the agent had answered: the ' +
    "user's message and your reply, as two turns. Use after `responder_turn_input`, only when " +
    'the user wants the exchange kept. The turn is marked: channel `mcp`, your `model` as the ' +
    'author (required), and a trace naming who answered. From then on it is part of the ' +
    "conversation: the agent's history window, its digests and replay all read it. Nothing " +
    'else runs: no tool, no model call, no phone push. Pass `input_trace_id` from ' +
    '`responder_turn_input` to link the two. Not for the team or client responders. ' +
    '`ask_responder` stays non-persisting.',
  shape: {
    message: z.string().min(1),
    reply: z.string().min(1),
    model: z.string().min(1),
    agent_slug: z.string().optional(),
    client: z.string().optional(),
    input_trace_id: z.string().optional(),
    tools_used: z.array(z.string()).optional(),
  },
  handler: (ctx) => {
    const { ownerId, jsonReply } = ctx;
    const threadLogin = threadLoginOf(ctx);
    return async (a) => {
      if (!threadLogin) return NO_LOGIN;
      try {
        const res = await recordMcpResponderTurn(ownerId, {
          // The connection's own thread (R3, W7c fix round 1, M1).
          loginId: threadLogin,
          message: a.message,
          reply: a.reply,
          model: a.model,
          ...(a.agent_slug ? { agentSlug: a.agent_slug } : {}),
          ...(a.client ? { client: a.client } : {}),
          ...(a.input_trace_id ? { inputTraceId: a.input_trace_id } : {}),
          ...(a.tools_used ? { toolsUsed: a.tools_used } : {}),
        });
        return jsonReply({
          recorded: true,
          agent: res.agent,
          inbound_id: res.inboundId,
          outbound_id: res.outboundId,
          trace_id: res.traceId,
        });
      } catch (err) {
        const msg = thrownToolDatabaseError('mcp responder_turn_record', err) ?? errorMessage(err);
        return {
          content: [{ type: 'text' as const, text: `responder_turn_record failed: ${msg}` }],
          isError: true,
        };
      }
    };
  },
});

/** The first sentence of a tool description: the gist, for the brief list. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(flat);
  const s = m ? m[1]! : flat;
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

// ── The table ───────────────────────────────────────────────────────────────

/** Every hand-written MCP tool, in registration order within its group. */
export const MCP_TOOL_DEFS: readonly McpToolDef[] = Object.freeze([
  TREE_LIST,
  SEARCH,
  FOLDER_DESCRIBE,
  FOLDER_RENAME,
  FILE_READ,
  FILE_GET,
  FILE_RENAME,
  PAGE_LIST,
  PAGE_GET,
  TABLE_LIST,
  TABLE_GET,
  TABLE_ROWS_LIST,
  ASK_RESPONDER,
  ASK_AS_RESPONDER,
  RESPONDER_TURN_INPUT,
  RESPONDER_TURN_RECORD,
]);

const BY_SLUG: ReadonlyMap<string, McpToolDef> = new Map(MCP_TOOL_DEFS.map((d) => [d.slug, d]));

/** The hand-written MCP tool named `slug`, or null. */
export function mcpDefinition(slug: string): McpToolDef | null {
  return BY_SLUG.get(slug) ?? null;
}

/** Register a group's definitions on the context's server, in table order,
 *  each when its opt-in holds (none of the sixteen has one). */
export function registerMcpTools(ctx: McpRegisterContext, group: McpToolGroup): void {
  for (const def of MCP_TOOL_DEFS) {
    if (def.group !== group) continue;
    def.register(ctx);
  }
}
