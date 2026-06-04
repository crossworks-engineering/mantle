/**
 * Built-in tool handlers — wrappers around existing workspace functions so
 * the agent runtime can call them via the same dispatch path as user-defined
 * tools. Every entry maps 1:1 to a row that gets upserted into the `tools`
 * table on agent boot.
 *
 * Slug convention: snake_case, matching the MCP tool name where one exists,
 * so the same name surfaces to Claude Code and to in-app agents.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, secrets, telegramChats } from '@mantle/db';
import { seal } from '@mantle/crypto';
import {
  searchNodes,
  searchChunks,
  searchEntities,
  entityNeighbors,
  entityFacts,
  entityMentions,
  graphPath,
} from '@mantle/search';
import { embed } from '@mantle/embeddings';
import {
  fileById,
  folderByPath,
  listAllFolders,
  listFiles,
  listFolders,
  readFileById,
  upsertFile,
} from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from './types';
import { WORKER_DELEGATION_TOOLS } from './builtins-workers';
import { EVENT_TOOLS } from './builtins-events';
import { TODO_TOOLS } from './builtins-todos';
import { PERSONA_TOOLS } from './builtins-persona';
import { TERMINAL_TOOLS } from './builtins-terminal';
import { RECALL_TOOLS } from './builtins-recall';
import { RESEARCH_TOOLS } from './builtins-research';
import { NOTE_TOOLS } from './builtins-notes';
import { EMAIL_TOOLS } from './builtins-email';
import { PAGE_TOOLS } from './builtins-pages';
import { TABLE_TOOLS } from './builtins-tables';
import { TOOL_RESULT_TOOLS } from './builtins-tool-results';
import { CONTACT_TOOLS } from './builtins-contacts';
import { LIFELOG_TOOLS } from './builtins-lifelog';
import { PEER_TOOLS } from './builtins-peers';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown, dflt?: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return dflt;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return out.length > 0 ? out : undefined;
}

// ─── search / tree ────────────────────────────────────────────────────────

const search_nodes: BuiltinToolDef = {
  slug: 'search_nodes',
  name: 'Search nodes',
  description:
    "Hybrid full-text + semantic search across the user's entire Mantle (notes, files, emails, events, todos, pages, telegram messages — everything). **Ranked by relevance, NOT by date.** " +
    "Use for topic/content questions — 'find emails about the Lister contract', 'notes mentioning the printer', 'anything about Ashley's passport'. " +
    "For **time-windowed** questions ('what arrived today', 'last 5 days of email', 'this week's events') use the dedicated list tools — `email_list`, `event_list`, `todo_list`, `note_list`, `page_list`, `file_list` — which ARE date-sorted and accept `since` / `window`. " +
    "For past **conversation** recall (replaying what was actually said) use `find_window` + `recall_window`. For the **public web** use `web_search`. " +
    "Optional `branch` (ltree prefix, e.g. 'files.work') scopes; `type` filters to one node kind; `tags` narrows further.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'free-text query' },
      branch: { type: 'string', description: "ltree prefix scope, e.g. 'files.work'" },
      type: {
        type: 'string',
        description: 'node type filter',
        enum: [
          'branch',
          'email',
          'email_thread',
          'file',
          'note',
          'page',
          'sermon',
          'contact',
          'task',
          'event',
          'printer_project',
          'telegram_message',
          'documentation',
          'lifelog',
        ],
      },
      tags: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  handler: async (input, ctx) => {
    try {
      const q = strOpt(input.q);
      // Embed the query so searchNodes runs its hybrid (vector-led) ranker —
      // the legacy FTS-only path recalls ~8% on natural-language queries
      // (docs/recall-eval.md). A failed embed degrades to FTS, not an error.
      let queryEmbedding: number[] | undefined;
      if (q && q.trim()) {
        try {
          queryEmbedding = await embed(ctx.ownerId, q);
        } catch (err) {
          console.error('[search_nodes] query embed failed, falling back to FTS:', err);
        }
      }
      const rows = await searchNodes({
        ownerId: ctx.ownerId,
        q,
        branch: strOpt(input.branch),
        type: strOpt(input.type) as Parameters<typeof searchNodes>[0]['type'],
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
        limit: num(input.limit, 20),
        queryEmbedding,
      });
      ctx.step?.setOutput({ count: rows.length });
      return {
        ok: true,
        output: rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          path: r.path,
          tags: r.tags,
          summary:
            typeof (r.data as Record<string, unknown> | null)?.summary === 'string'
              ? (r.data as Record<string, unknown>).summary
              : null,
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const search_chunks: BuiltinToolDef = {
  slug: 'search_chunks',
  name: 'Search document passages',
  description:
    'Semantic (vector) search over document passages — finds the most relevant *sections* inside long pages, files, emails, and documentation (not just whole-node hits). Use when `search_nodes` is too coarse or you want the specific passage. ' +
    "`branch` scopes by ltree path (e.g. 'documentation' for the docs). Each hit returns the source node id (use `node_read` to open the whole doc), its heading, and the passage text.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'free-text query' },
      branch: { type: 'string', description: "ltree prefix scope, e.g. 'documentation'" },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['q'],
  },
  handler: async (input, ctx) => {
    try {
      const q = str(input.q);
      if (!q) return { ok: false, error: 'q is required' };
      const embedding = await embed(ctx.ownerId, q);
      const hits = await searchChunks({
        ownerId: ctx.ownerId,
        embedding,
        branch: strOpt(input.branch),
        limit: num(input.limit, 10),
      });
      ctx.step?.setOutput({ count: hits.length });
      return {
        ok: true,
        output: hits.map((h) => ({
          nodeId: h.nodeId,
          nodeTitle: h.nodeTitle,
          nodeType: h.nodeType,
          heading: h.headingPath,
          text: h.text,
        })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const tree_list: BuiltinToolDef = {
  slug: 'tree_list',
  name: 'List tree children',
  description:
    "List children of a branch in the user's tree (the universal navigator — whatever kinds of nodes live under that branch). Pass `path` to scope (ltree, e.g. 'files.work'). Omit for top-level branches. " +
    "For files specifically use `file_list`; for folders use `folder_list`; for searching by content/topic use `search_nodes`.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'parent ltree path; omit for top-level' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    },
  },
  handler: async (input, ctx) => {
    const path = strOpt(input.path);
    const limit = num(input.limit, 100) ?? 100;
    const conds = [eq(nodes.ownerId, ctx.ownerId)];
    if (path) conds.push(sql`${nodes.path}::text = ${path}`);
    else conds.push(eq(nodes.type, 'branch'));
    const rows = await db
      .select({ id: nodes.id, title: nodes.title, type: nodes.type, path: nodes.path })
      .from(nodes)
      .where(and(...conds))
      .orderBy(desc(nodes.updatedAt))
      .limit(limit);
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

// ─── entities / facts ─────────────────────────────────────────────────────

const entity_search: BuiltinToolDef = {
  slug: 'entity_search',
  name: 'Search entities',
  description:
    "Resolve a name or alias to entities the user has accumulated (people, projects, places, orgs, events). Returns hits with similarity scores. Use this when the user mentions someone or something by name and you need their internal id.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'name or alias to resolve' },
      kind: {
        type: 'string',
        description: 'optional kind filter',
        enum: ['person', 'project', 'place', 'org', 'event'],
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['q'],
  },
  handler: async (input, ctx) => {
    const q = str(input.q);
    if (!q) return { ok: false, error: 'q required' };
    const rows = await searchEntities({
      ownerId: ctx.ownerId,
      q,
      kind: strOpt(input.kind),
      limit: num(input.limit, 10),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const entity_neighbors: BuiltinToolDef = {
  slug: 'entity_neighbors',
  name: 'Walk entity neighbors',
  description:
    "Given an entity id, return connected entities one hop away (in both directions by default). Use after entity_search to expand context, e.g. 'who works with Sarah?' or 'what projects mention Lister?'.",
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', format: 'uuid' },
      relation: { type: 'string' },
      direction: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' },
      current_only: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityNeighbors({
      ownerId: ctx.ownerId,
      entityId,
      relation: strOpt(input.relation),
      direction: (strOpt(input.direction) ?? 'both') as 'in' | 'out' | 'both',
      currentOnly: bool(input.current_only),
      limit: num(input.limit, 25),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const graph_path: BuiltinToolDef = {
  slug: 'graph_path',
  name: 'Walk the entity graph (multi-hop)',
  description:
    "Multi-hop traversal of the knowledge graph — the relationships BETWEEN entities (e.g. 'Sarah works_at Lister', 'Lister supplies Acme'). Use for connection questions one hop can't answer: 'how is Sarah connected to Acme?' (pass from_id + to_id → shortest path) or 'what's within 2 hops of Lister?' (pass from_id only → reachable neighbourhood). Get ids from entity_search first. `relations` filters which verbs to follow; `directed:true` follows subject→object only (default treats edges as undirected for connectivity). For a single hop use entity_neighbors instead.",
  inputSchema: {
    type: 'object',
    properties: {
      from_id: { type: 'string', format: 'uuid', description: 'Start entity id.' },
      to_id: {
        type: 'string',
        format: 'uuid',
        description: 'Optional target entity id — returns shortest path(s) to it.',
      },
      max_depth: { type: 'integer', minimum: 1, maximum: 6, default: 3 },
      relations: {
        type: 'array',
        items: { type: 'string' },
        description: "Only follow these relation verbs, e.g. ['employed_by','owns'].",
      },
      directed: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    required: ['from_id'],
  },
  handler: async (input, ctx) => {
    const fromId = str(input.from_id);
    if (!fromId) return { ok: false, error: 'from_id required' };
    const rows = await graphPath({
      ownerId: ctx.ownerId,
      fromId,
      toId: strOpt(input.to_id),
      maxDepth: num(input.max_depth, 3),
      relations: strArr(input.relations),
      directed: bool(input.directed),
      limit: num(input.limit, 50),
    });
    ctx.step?.setMeta({ count: rows.length, reached: !!input.to_id && rows.length > 0 });
    return {
      ok: true,
      output: rows.map((r) => ({
        entity: { id: r.entity.id, name: r.entity.name, kind: r.entity.kind },
        depth: r.depth,
        path: r.path,
      })),
    };
  },
};

const entity_facts: BuiltinToolDef = {
  slug: 'entity_facts',
  name: 'List entity facts',
  description:
    "All facts the user has accumulated about a specific entity (what they KNOW about that person/place/thing). Returns currently-valid facts by default; set include_retired=true to see superseded history. " +
    "Get the entity id from `entity_search` first. For content nodes (emails, notes, files) that MENTION the entity use `entity_mentions`; to walk to connected entities use `entity_neighbors`.",
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', format: 'uuid' },
      include_retired: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityFacts({
      ownerId: ctx.ownerId,
      entityId,
      includeRetired: bool(input.include_retired),
      limit: num(input.limit, 50),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const entity_mentions: BuiltinToolDef = {
  slug: 'entity_mentions',
  name: 'List entity mentions',
  description:
    "Content nodes (files, notes, emails, …) that mention a given entity, newest first. Returns title + per-node summary so the model can decide which to dig into. " +
    "Get the entity id from `entity_search` first. For distilled facts ABOUT the entity (what the user knows) use `entity_facts`; to walk to connected entities use `entity_neighbors`.",
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', format: 'uuid' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    },
    required: ['entity_id'],
  },
  handler: async (input, ctx) => {
    const entityId = str(input.entity_id);
    if (!entityId) return { ok: false, error: 'entity_id required' };
    const rows = await entityMentions({
      ownerId: ctx.ownerId,
      entityId,
      limit: num(input.limit, 25),
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

// ─── files / folders ──────────────────────────────────────────────────────

const folder_list: BuiltinToolDef = {
  slug: 'folder_list',
  name: 'List folders',
  description:
    "List folders (only) in the user's host-mirrored filesystem. Pass `parent` (ltree path, e.g. 'files.work') for that folder's immediate sub-folders; pass `tree: true` for every folder under the root. " +
    "For files inside a folder use `file_list`; for a file's actual content use `file_read`; for searching files by content/topic use `search_nodes` with `type='file'`.",
  inputSchema: {
    type: 'object',
    properties: {
      parent: { type: 'string' },
      tree: { type: 'boolean', default: false },
    },
  },
  handler: async (input, ctx) => {
    if (bool(input.tree)) {
      const rows = await listAllFolders(ctx.ownerId);
      ctx.step?.setOutput({ count: rows.length });
      return { ok: true, output: rows };
    }
    const parent = strOpt(input.parent) ?? 'files';
    const rows = await listFolders({ ownerId: ctx.ownerId, parentPath: parent });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const file_list: BuiltinToolDef = {
  slug: 'file_list',
  name: 'List files in a folder',
  description:
    "List files (only) inside a specific folder. `parent_path` is the ltree path of the folder (e.g. 'files.work.lister-printer'). " +
    "For sub-folders within that folder use `folder_list`; for a file's actual content use `file_read`; for searching files by content/topic across the whole tree use `search_nodes` with `type='file'`.",
  inputSchema: {
    type: 'object',
    properties: { parent_path: { type: 'string' } },
    required: ['parent_path'],
  },
  handler: async (input, ctx) => {
    const parentPath = str(input.parent_path);
    if (!parentPath) return { ok: false, error: 'parent_path required' };
    const rows = await listFiles({ ownerId: ctx.ownerId, parentPath });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

const node_read: BuiltinToolDef = {
  slug: 'node_read',
  name: 'Read a node',
  description:
    "Universal reader — read the full content of any node by id. Returns title, type, tags, path, summary, and the full `data` blob (markdown body for notes, body+location+starts_at for events, status+due_at for tasks, etc.). " +
    "**Prefer type-specific readers when available** — `note_get` / `event_get` / `todo_get` / `page_get` / `email_get` — they return cleaner shapes for their type. " +
    "For nodes of `type='file'` the body lives in object storage — use `file_read` instead. This tool is the fallback that works for any node type (incl. secret, sermon, contact, telegram_message).",
  inputSchema: {
    type: 'object',
    properties: { node_id: { type: 'string', format: 'uuid' } },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    const nodeId = str(input.node_id);
    if (!nodeId) return { ok: false, error: 'node_id required' };
    const [row] = await db
      .select({
        id: nodes.id,
        type: nodes.type,
        title: nodes.title,
        path: nodes.path,
        tags: nodes.tags,
        data: nodes.data,
        createdAt: nodes.createdAt,
        updatedAt: nodes.updatedAt,
      })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
      .limit(1);
    if (!row) return { ok: false, error: 'node not found' };
    ctx.step?.setOutput({ type: row.type });
    return {
      ok: true,
      output: {
        id: row.id,
        type: row.type,
        title: row.title,
        path: row.path,
        tags: row.tags,
        data: row.data,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  },
};

const SECRET_KIND_VALUES = [
  'password',
  'token',
  'server',
  'card',
  'note',
  'other',
] as const;

const SECRETS_ROOT_LABEL = 'secrets';

const secret_create: BuiltinToolDef = {
  slug: 'secret_create',
  name: 'Capture a secret',
  description:
    "Capture a sensitive value — password, PIN, API key, recovery code, anything the user explicitly says is private — into the encrypted /secrets store. ALWAYS prefer this over `note_create` or `file_create` when the user dictates a credential or asks you to remember something private; saving secrets as notes leaves them in plaintext where any future tool call can read them, while this tool seals the value with AES-256-GCM behind a key only the owner's browser session can unlock. The value is REDACTED in trace logs — never echo it back to the user; confirm by title only ('saved your safe PIN'). For multi-field secrets (e.g. a server with both username and password), the /secrets UI is still the right path; this tool handles the common one-value case.",
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'short label, e.g. "Safe PIN", "Linode root password"',
      },
      value: {
        type: 'string',
        description: 'the secret value itself — gets encrypted before storage',
      },
      kind: {
        type: 'string',
        enum: [...SECRET_KIND_VALUES],
        description: 'rough category; pick the closest match',
      },
      label: {
        type: 'string',
        description:
          "optional field label inside the secret (e.g. 'PIN', 'password'). Defaults to 'value'.",
      },
      description: {
        type: 'string',
        description: 'optional plaintext metadata visible to search (do NOT include the value here)',
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'value', 'kind'],
  },
  redactInputFields: ['value'],
  handler: async (input, ctx) => {
    const title = str(input.title).trim();
    const value = str(input.value);
    const kindRaw = str(input.kind);
    const label = str(input.label).trim() || 'value';
    const description = str(input.description).slice(0, 4000);
    const tagsIn = Array.isArray(input.tags)
      ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    if (!title) return { ok: false, error: 'title required' };
    if (!value) return { ok: false, error: 'value required' };
    const kind = (SECRET_KIND_VALUES as readonly string[]).includes(kindRaw)
      ? kindRaw
      : 'other';

    // Lazy-create the `secrets` ltree root the same way the UI does.
    await db
      .insert(nodes)
      .values({
        ownerId: ctx.ownerId,
        type: 'branch',
        title: 'Secrets',
        slug: SECRETS_ROOT_LABEL,
        path: SECRETS_ROOT_LABEL,
        data: {
          description:
            'Encrypted credentials, tokens, and other sensitive notes. Metadata is searchable; values stay sealed until you click reveal.',
        },
      })
      .onConflictDoNothing({
        target: [nodes.ownerId, nodes.path],
        where: sql`${nodes.type} = 'branch'`,
      });

    // Sanitise tags (max 20, lowercase, dedup, 40 chars each).
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const raw of tagsIn) {
      const t = raw.trim().toLowerCase();
      if (!t || t.length > 40 || seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
      if (tags.length >= 20) break;
    }

    // Insert metadata row first to get the node id (needed as AAD).
    const [inserted] = await db
      .insert(nodes)
      .values({
        ownerId: ctx.ownerId,
        type: 'secret',
        title: title.slice(0, 200),
        slug: null,
        path: SECRETS_ROOT_LABEL,
        data: {
          description,
          kind,
          has_note: false,
          field_count: 1,
        },
        tags,
      })
      .returning();
    if (!inserted) return { ok: false, error: 'failed to insert secret node' };

    // Seal the payload — single labeled field. AAD binds ciphertext to
    // this node id so an attacker who swaps the bytea column can't
    // replay another secret's ciphertext into this row.
    const payload = JSON.stringify({
      note: '',
      fields: [{ label: label.slice(0, 60), value }],
    });
    const sealed = seal(payload, `secret:${inserted.id}`);
    await db.insert(secrets).values({
      nodeId: inserted.id,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    });

    // Trace meta deliberately omits the value. setOutput is also
    // safe: only id + title + kind. Never include the value here.
    ctx.step?.setOutput({ id: inserted.id, title: inserted.title, kind });
    return {
      ok: true,
      output: {
        id: inserted.id,
        title: inserted.title,
        kind,
        message:
          "Saved to /secrets. The value is sealed — confirm by title only, do not repeat it back to the user.",
      },
    };
  },
};

const file_read: BuiltinToolDef = {
  slug: 'file_read',
  name: 'Read a file',
  description:
    "Read a file's content by id. For text files (.md / .txt / .json / .yaml) returns the body as a utf-8 string. For binaries the extractor stores the parsed text (PDF / Word / Excel) as `data.text`, which is returned here — so you can read or quote the document's actual contents, not just its summary. Returns `content: null` only when no text could be extracted (e.g. a scanned image with no OCR). Use `node_read` for notes/events/tasks/secrets.",
  inputSchema: {
    type: 'object',
    properties: { file_id: { type: 'string', format: 'uuid' } },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return { ok: false, error: 'file not found' };
    if (!meta.isText) {
      // Binary (pdf/docx/xlsx). Bytes aren't useful to the LLM, but the
      // extractor persists the parsed text as data.text — return that so
      // the assistant can reproduce the document's content.
      const [n] = await db
        .select({ data: nodes.data })
        .from(nodes)
        .where(and(eq(nodes.id, meta.id), eq(nodes.ownerId, ctx.ownerId)))
        .limit(1);
      const text =
        n && typeof (n.data as Record<string, unknown>)?.text === 'string'
          ? ((n.data as Record<string, unknown>).text as string)
          : null;
      ctx.step?.setOutput({ binary: true, hasExtractedText: !!text, textChars: text?.length ?? 0 });
      return { ok: true, output: { file: meta, content: text } };
    }
    const res = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!res) return { ok: false, error: 'file not found' };
    return { ok: true, output: { file: meta, content: res.bytes.toString('utf8') } };
  },
};

const file_get: BuiltinToolDef = {
  slug: 'file_get',
  name: 'Fetch file metadata',
  description:
    "Fetch a file's metadata (filename, mime type, size, sha) — no bytes. Use to confirm size/type before deciding to read a large/binary file. " +
    "For the actual file content use `file_read`; for listing files in a folder use `file_list`.",
  inputSchema: {
    type: 'object',
    properties: { file_id: { type: 'string', format: 'uuid' } },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const row = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!row) return { ok: false, error: 'file not found' };
    return { ok: true, output: row };
  },
};

const folder_get_by_path: BuiltinToolDef = {
  slug: 'folder_get_by_path',
  name: 'Look up folder by path',
  description:
    "Look up a folder's metadata + description by its ltree path. " +
    "For listing what's IN the folder use `folder_list` (sub-folders) or `file_list` (files).",
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  handler: async (input, ctx) => {
    const path = str(input.path);
    if (!path) return { ok: false, error: 'path required' };
    const row = await folderByPath({ ownerId: ctx.ownerId, path });
    if (!row) return { ok: false, error: 'folder not found' };
    return { ok: true, output: row };
  },
};

const file_create: BuiltinToolDef = {
  slug: 'file_create',
  name: 'Create / overwrite a file',
  description:
    "Create or overwrite a **named text file** in a specific folder (e.g. `notes.md`, `config.json`, `recipe.txt`). Use when the user asks for a file with a particular name/extension in a particular place. Filename is lowercased and sanitised automatically. " +
    "For a plain note that goes into /notes (no filename/folder needed, auto-indexed) use `note_create`. For credentials/passwords use `secret_create`. For a rich-text doc (TipTap) use `page_create`.",
  requiresConfirm: false, // text-only writes are usually safe; user can flip per agent
  inputSchema: {
    type: 'object',
    properties: {
      parent_path: { type: 'string', description: "ltree path of the parent folder" },
      filename: { type: 'string', description: 'with extension, e.g. notes.md' },
      content: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
    },
    required: ['parent_path', 'filename', 'content'],
  },
  handler: async (input, ctx) => {
    const parentPath = str(input.parent_path);
    const filename = str(input.filename);
    const content = str(input.content);
    if (!parentPath || !filename) {
      return { ok: false, error: 'parent_path + filename required' };
    }
    try {
      const row = await upsertFile({
        ownerId: ctx.ownerId,
        parentPath,
        filename,
        bytes: Buffer.from(content, 'utf8'),
        overwrite: bool(input.overwrite),
      });
      ctx.step?.setOutput({ fileId: row.id });
      // Saskia-driven file create is itself a data entry event.
      // The biography view for the new file picks this up so the
      // operator can see "Saskia created this in response to a
      // user request" rather than "appeared from nowhere."
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: row.id,
        summary: `File created by tool: ${row.filename}`,
        payload: {
          parentPath,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          via: 'file_create_tool',
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: content,
      });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ─── telegram ─────────────────────────────────────────────────────────────

import { accountForChat, sendMessage } from '@mantle/telegram';

// ─── system / triggers ────────────────────────────────────────────────────

const process_extraction: BuiltinToolDef = {
  slug: 'process_extraction',
  name: 'Kick the extractor',
  description:
    "Re-fires the pg_notify('node_ingested') signal for any nodes missing data.summary or embedding. Optional `node_id` to target a single node; optional `types` to restrict by node kind; optional `limit` to cap (default 100). Idempotent — already-extracted nodes are short-circuited by the extractor.",
  inputSchema: {
    type: 'object',
    properties: {
      node_id: { type: 'string', format: 'uuid', description: 'optional single node to re-extract' },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'optional node-type filter (e.g. ["file","note"])',
      },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    },
  },
  handler: async (input, ctx) => {
    const limit = num(input.limit, 100) ?? 100;
    if (typeof input.node_id === 'string' && input.node_id) {
      // Fire for exactly one node, no eligibility check — operator chose it.
      await notifyNodeIngested(input.node_id);
      ctx.step?.setOutput({ fired: 1, node_id: input.node_id });
      return { ok: true, output: { fired: 1, node_id: input.node_id } };
    }
    const typeFilter = Array.isArray(input.types)
      ? (input.types as string[])
      : null;
    const conds = [
      eq(nodes.ownerId, ctx.ownerId),
      sql`${nodes.type} <> 'branch'`,
      sql`${nodes.type} <> 'secret'`,
      sql`(${nodes.data}->>'summary' is null or ${nodes.embedding} is null)`,
    ];
    if (typeFilter && typeFilter.length > 0) {
      conds.push(sql`${nodes.type}::text = any(${typeFilter}::text[])`);
    }
    const rows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(...conds))
      .orderBy(desc(nodes.createdAt))
      .limit(limit);
    for (const r of rows) {
      await notifyNodeIngested(r.id);
    }
    ctx.step?.setOutput({ fired: rows.length });
    return { ok: true, output: { fired: rows.length } };
  },
};

const telegram_send: BuiltinToolDef = {
  slug: 'telegram_send',
  name: 'Send a Telegram message',
  description:
    "Send a Telegram DM to one of the user's allowlisted chats. Use only when explicitly asked to message someone — never on the user's initiative without confirmation.",
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: "Telegram's numeric chat id (as string)" },
      text: { type: 'string', minLength: 1 },
      reply_to: { type: 'string', description: "optional telegram_message_id to thread under" },
      markdown: { type: 'boolean', default: false },
    },
    required: ['chat_id', 'text'],
  },
  handler: async (input, ctx) => {
    const chatId = str(input.chat_id);
    const text = str(input.text);
    if (!chatId || !text) return { ok: false, error: 'chat_id + text required' };
    const account = await accountForChat(chatId);
    if (!account) return { ok: false, error: 'no enabled telegram account for this chat' };
    // Verify allowlist on this owner.
    const [chat] = await db
      .select({ status: telegramChats.allowlistStatus })
      .from(telegramChats)
      .where(
        and(eq(telegramChats.userId, ctx.ownerId), eq(telegramChats.telegramChatId, chatId)),
      )
      .limit(1);
    if (!chat || chat.status !== 'allowed') {
      return { ok: false, error: `chat ${chatId} is not allowlisted` };
    }
    try {
      const ids = await sendMessage(account, chatId, text, {
        replyTo: strOpt(input.reply_to),
        markdown: bool(input.markdown),
      });
      ctx.step?.setOutput({ messageIds: ids });
      return { ok: true, output: { messageIds: ids } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ─── export the catalog ───────────────────────────────────────────────────

// ─── agent delegation ─────────────────────────────────────────────────────

const invoke_agent: BuiltinToolDef = {
  slug: 'invoke_agent',
  name: 'Delegate to another agent',
  description:
    "Hand off a single, self-contained prompt to another agent (e.g. a researcher with a stronger model + retrieval tools). Use only when the work would clearly benefit from a different persona or model — not for routing every turn. The child runs once and returns its final text; its conversation history is NOT shared with the parent. The parent agent's `memory_config.delegate_to` must list the target slug, or this call is refused.",
  inputSchema: {
    type: 'object',
    required: ['agent_slug', 'prompt'],
    properties: {
      agent_slug: {
        type: 'string',
        description: 'Slug of the target agent (the `agents.slug` column).',
      },
      prompt: {
        type: 'string',
        description:
          'Self-contained instructions for the child. Include any context it needs; the child does not see your conversation history.',
        maxLength: 32_000,
      },
    },
  },
  handler: async (input, ctx) => {
    // Lazy imports keep the guard module + bridge out of the cold-
    // start path of every other builtin. They're tiny but the
    // separation lets us test them as pure helpers.
    const { checkAgentDepth, checkDelegationAllowed } = await import(
      './invoke-agent-guards'
    );
    const { getAgentInvoker } = await import('./agent-bridge');

    if (!ctx.agent) {
      return {
        ok: false,
        error:
          'invoke_agent: missing parent agent context — runToolLoop did not populate ctx.agent. This is a wiring bug.',
      };
    }

    const targetSlug = str(input.agent_slug);
    const prompt = str(input.prompt);
    if (!targetSlug) return { ok: false, error: 'agent_slug is required' };
    if (!prompt) return { ok: false, error: 'prompt is required' };

    // Guardrail 3: explicit allowlist + no self-call.
    const allowed = checkDelegationAllowed(
      ctx.agent.slug,
      targetSlug,
      ctx.agent.delegateTo,
    );
    if (!allowed.ok) return { ok: false, error: allowed.reason };

    // Guardrail 1: bounded depth. checkAgentDepth returns the depth
    // the child would run at, or refuses outright.
    const depth = checkAgentDepth(ctx.agent.depth);
    if (!depth.ok) return { ok: false, error: depth.reason };

    const invoker = getAgentInvoker();
    if (!invoker) {
      return {
        ok: false,
        error:
          'invoke_agent: no agent invoker registered in this process. Call registerAgentInvoker() at boot.',
      };
    }

    // Guardrail 2: synchronous. Await the child's final result. The
    // child's cost is captured in the child's own trace; we surface
    // it in the parent step's meta for /traces visibility, but the
    // parent's `traces.cost_micro_usd` does NOT roll it up — that
    // would double-count in /debug aggregates.
    const result = await invoker({
      ownerId: ctx.ownerId,
      agentSlug: targetSlug,
      prompt,
      depth: depth.childDepth,
      parentTraceId: ctx.agent.parentTraceId ?? null,
    });
    if (!result.ok) {
      return { ok: false, error: `child agent failed: ${result.error}` };
    }
    ctx.step?.setMeta({
      child_trace_id: result.childTraceId,
      child_cost_micro_usd: result.costMicroUsd,
      child_tokens_in: result.tokensIn,
      child_tokens_out: result.tokensOut,
      delegated_to: targetSlug,
    });
    return {
      ok: true,
      output: {
        text: result.text,
        child_trace_id: result.childTraceId,
      },
    };
  },
};

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  search_nodes,
  search_chunks,
  tree_list,
  entity_search,
  entity_neighbors,
  graph_path,
  entity_facts,
  entity_mentions,
  folder_list,
  folder_get_by_path,
  file_list,
  file_get,
  file_read,
  node_read,
  secret_create,
  file_create,
  telegram_send,
  process_extraction,
  invoke_agent,
  // Worker-delegation tools live in builtins-workers.ts so they can
  // share helpers without bloating this file. Each one bridges
  // Saskia's agency to a configured ai_workers row — TTS, vision,
  // summarizer.
  ...WORKER_DELEGATION_TOOLS,
  // Event CRUD — mirrors the MCP event tools so Saskia can schedule
  // and manage calendar items from chat. None require_confirm by
  // operator choice; flip per-row in the tools table if you want
  // approval gates.
  ...EVENT_TOOLS,
  // Todo CRUD — mirrors the MCP todo tools so Saskia can capture and
  // manage tasks from chat. None require_confirm (trivially reversible).
  ...TODO_TOOLS,
  // Persona self-edit — lets Saskia adjust her own style/relationship
  // notes when the user explicitly asks ("be more professional").
  // Scoped resolution + soft-retire; pure logic in @mantle/db.
  ...PERSONA_TOOLS,
  // Free-form terminal — UNRESTRICTED shell access for a power-user's
  // dedicated coder/ops agent (not for the untrusted-inbound responder).
  // See builtins-terminal.ts for the safety rationale.
  ...TERMINAL_TOOLS,
  // Recall — time-windowed replay of past conversations from the
  // permanent message archive. The toolset for the `remy` recall agent
  // (find_window locates via digests, recall_window pulls raw turns).
  ...RECALL_TOOLS,
  // Research — outward to the live internet via Perplexity Sonar. The
  // raw-search primitive for the `researcher` agent; the smart layer is
  // the agent that wraps it (plan → search → cross-check → synthesise).
  ...RESEARCH_TOOLS,
  // Notes — persist a markdown note (auto-indexed into the brain). Lets
  // Saskia keep research findings she's decided are worth saving.
  ...NOTE_TOOLS,
  // Email — send mail from the user's own mailbox via provider SMTP. Pairs
  // with web_search/researcher ("research X and email it to me").
  ...EMAIL_TOOLS,
  // Pages — author rich documents (CRUD). Saskia writes the rich-markdown
  // dialect; markdownToDoc converts it to the ProseMirror JSON pages store.
  // page_delete is requires_confirm (irreversible).
  ...PAGE_TOOLS,
  // Tables — author + operate typed database grids (CRUD + row/column/cell
  // edits + totals + saved views). Stable row/column ids make "do row X" /
  // "total column Y" addressable; structural edits write to draft_data.
  ...TABLE_TOOLS,
  // read_result — dereference a spilled (oversized) tool result by handle:
  // page / grep / semantic query. The tool-loop always offers this so a
  // stored handle is never a dead end. Read-only.
  ...TOOL_RESULT_TOOLS,
  // Contacts — the index of people/orgs Saskia may email (and later SMS).
  // Contacts list IS the email allowlist; adding a contact extends reach.
  // Saskia adds/edits only when explicitly asked (tool descriptions emphasise).
  ...CONTACT_TOOLS,
  // Life Logs — the user's first-person self-knowledge (who they are, work,
  // family, feelings). Source of the always-on identity context. Saskia can
  // add/refine entries when the user shares something durable about themselves.
  ...LIFELOG_TOOLS,
  // Federation — query other people's Mantles for data they've shared with
  // you. Outbound half of docs/federation.md; reads only what a peer granted.
  ...PEER_TOOLS,
];
