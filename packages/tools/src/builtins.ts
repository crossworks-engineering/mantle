/**
 * Built-in tool handlers — wrappers around existing workspace functions so
 * the agent runtime can call them via the same dispatch path as user-defined
 * tools. Every entry maps 1:1 to a row that gets upserted into the `tools`
 * table on agent boot.
 *
 * Slug convention: snake_case, matching the MCP tool name where one exists,
 * so the same name surfaces to Claude Code and to in-app agents.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  agents,
  contentChunks,
  db,
  nodes,
  notifyNodeIngested,
  secrets,
  telegramChats,
} from '@mantle/db';
import { seal } from '@mantle/crypto';
import {
  searchNodes,
  searchChunks,
  readSection,
  buildSectionOutline,
  searchEntities,
  entityNeighbors,
  entityFacts,
  entityMentions,
  graphPath,
  resolveSupersededTargets,
} from '@mantle/search';
import { embed } from '@mantle/embeddings';
import {
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
} from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { corpusCapacity, nodeUrl, supersedeNode, unsupersedeNode } from '@mantle/content';
import type { BuiltinToolDef, ToolPrecondition } from './types';
import { WORKER_DELEGATION_TOOLS } from './builtins-workers';
import { EVENT_TOOLS } from './builtins-events';
import { PROFILE_TOOLS } from './builtins-profile';
import { TASK_TOOLS } from './builtins-tasks';
import { TEAM_TOOLS } from './builtins-team';
import { PERSONA_TOOLS } from './builtins-persona';
import { TERMINAL_TOOLS } from './builtins-terminal';
import { RECALL_TOOLS } from './builtins-recall';
import { RESEARCH_TOOLS } from './builtins-research';
import { NOTE_TOOLS } from './builtins-notes';
import { EMAIL_TOOLS } from './builtins-email';
import { PAGE_TOOLS } from './builtins-pages';
import { SHARE_TOOLS } from './builtins-share';
import { APP_TOOLS, APP_DATA_TOOLS } from './builtins-apps';
import { TABLE_TOOLS } from './builtins-tables';
import { TOOL_RESULT_TOOLS } from './builtins-tool-results';
import { CONTACT_TOOLS } from './builtins-contacts';
import { JOURNAL_TOOLS } from './builtins-journal';
import { PEER_TOOLS } from './builtins-peers';
import { EVAL_TOOLS } from './builtins-eval';
import { RUN_TOOLS } from './builtins-runs';
import { TOOLSMITH_TOOLS } from './builtins-toolsmith';
import { LOCATION_TOOLS } from './builtins-locations';
import { EXPORT_TOOLS } from './builtins-export';
import { str } from './coerce';

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

/**
 * Intentionally NOT the shared `strArrOpt` from './coerce': this variant also
 * drops empty-string members (`s.length > 0`), which `strArrOpt` deliberately
 * preserves. Kept local so that empty-dropping semantic stays with its one
 * call site (`relations`) rather than silently changing the shared contract.
 */
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return out.length > 0 ? out : undefined;
}

// Shared referential preconditions (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING node the owner holds.
// Folders are `type='branch'` nodes; the "any node" variant leaves nodeType
// unset so universal readers keep working across every kind.
const NODE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'node_id', lookup: 'search_nodes / tree_list' },
];
const FILE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'file_id', nodeType: 'file', lookup: 'file_list / search_nodes' },
];
const FOLDER_ID_PRE: readonly ToolPrecondition[] = [
  {
    kind: 'node_exists',
    param: 'folder_id',
    nodeType: 'branch',
    lookup: 'folder_list / tree_list',
  },
];

// ─── search / tree ────────────────────────────────────────────────────────

const search_nodes: BuiltinToolDef = {
  slug: 'search_nodes',
  name: 'Search nodes',
  description:
    "Hybrid full-text + semantic search across the user's entire Mantle (notes, files, emails, events, tasks, pages, telegram messages — everything). **Ranked by relevance, NOT by date.** " +
    "Use for topic/content questions — 'find emails about the Lister contract', 'notes mentioning the printer', 'anything about Alice's passport'. " +
    'This finds whole NODES (returns their spine — title/tags/summary). To pull the relevant *passages* from inside long documents — the cheaper move for a "what does X say about Y" question, and the one that avoids reading whole files into context — use `search_chunks`. ' +
    "For **time-windowed** questions ('what arrived today', 'last 5 days of email', 'this week's events') use the dedicated list tools — `email_list`, `event_list`, `task_list`, `note_list`, `page_list`, `file_list` — which ARE date-sorted and accept `since` / `window`. " +
    'For past **conversation** recall (replaying what was actually said) use `find_window` + `recall_window`. For the **public web** use `web_search`. ' +
    "Optional `branch` (ltree prefix, e.g. 'files.work') scopes; `type` filters to one node kind; `tags` narrows further. " +
    'Each hit carries a `url` permalink — when you surface an item to the user, link it as a markdown `[title](url)` so they can click straight through to it.',
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
          'journal',
          'formula',
        ],
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "only nodes carrying at least one of these tags, e.g. ['work']",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
        description: 'Max results to return.',
      },
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
      // Content-currency annotation: a superseded hit still surfaces (the
      // demotion is a nudge, not a filter) but must carry its living
      // successor so the model prefers the current copy.
      const successors = await resolveSupersededTargets(
        ctx.ownerId,
        rows.filter((r) => r.supersededBy).map((r) => r.id),
      );
      return {
        ok: true,
        output: rows.map((r) => {
          const succ = successors.get(r.id);
          return {
            id: r.id,
            type: r.type,
            title: r.title,
            path: r.path,
            tags: r.tags,
            url: nodeUrl(r.id),
            summary:
              typeof (r.data as Record<string, unknown> | null)?.summary === 'string'
                ? (r.data as Record<string, unknown>).summary
                : null,
            updatedAt: r.updatedAt.toISOString(),
            ...(succ
              ? {
                  superseded_by: {
                    id: succ.id,
                    title: succ.title,
                    url: nodeUrl(succ.id),
                    note: 'SUPERSEDED — prefer this successor; do not present the old copy as current.',
                  },
                }
              : {}),
          };
        }),
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
    'Semantic (vector) search over document passages — finds the most relevant *sections* inside long files, pages, emails, and documentation (not just whole-node hits). **Reach for this FIRST on a content question** ("what does the CoF procedure say about inventory grouping?"): it returns the exact passages, so you answer (and quote) without loading whole files into context. ' +
    "`branch` scopes by ltree path (e.g. 'files' for uploaded documents, 'pages', 'documentation'). Each hit returns the source node id, its heading, ordinal, and passage text. Quote the passage directly. When you need the WHOLE section in order (a full procedure/clause/table), don't read the entire file — pass the hit's `nodeId` + `heading` (or ordinal) to `read_section`. Only `file_read` / `node_read` the whole document for a short file or an explicit exhaustive review.",
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'free-text query' },
      branch: {
        type: 'string',
        description: "ltree prefix scope, e.g. 'files' or 'documentation'",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Max results to return.',
      },
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
        // Hybrid: the query text feeds the FTS booster arm, so exact rare
        // tokens (error codes, field names) are findable alongside vector.
        q,
        branch: strOpt(input.branch),
        limit: num(input.limit, 10),
      });
      ctx.step?.setOutput({ count: hits.length });
      // Content-currency annotation: passages from a superseded node carry
      // their living successor so the model quotes the current copy instead.
      const successors = await resolveSupersededTargets(
        ctx.ownerId,
        hits.filter((h) => h.nodeSupersededBy).map((h) => h.nodeId),
      );
      return {
        ok: true,
        output: hits.map((h) => {
          const succ = successors.get(h.nodeId);
          return {
            nodeId: h.nodeId,
            nodeTitle: h.nodeTitle,
            nodeType: h.nodeType,
            heading: h.headingPath,
            ordinal: h.ordinal,
            text: h.text,
            ...(succ
              ? {
                  superseded_by: {
                    id: succ.id,
                    title: succ.title,
                    note: 'SUPERSEDED — this passage is from an outdated copy; check the successor before quoting.',
                  },
                }
              : {}),
          };
        }),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const read_section: BuiltinToolDef = {
  slug: 'read_section',
  name: 'Read a document section',
  description:
    "Read one SECTION of a long document in full and in order — the rung between `search_chunks` (scattered passages) and `file_read`/`node_read` (the entire document). Reach for this once you know WHERE the answer lives: feed a `search_chunks` hit's `nodeId` plus its `heading` (or an ordinal range) here to read the whole procedure / clause / table contiguously, WITHOUT loading the entire file into context. " +
    "Pass ONLY `node_id` to get the OUTLINE (heading ranges with their ordinals) and pick a section from the document's structure. Output is capped (~24k chars) and returns `next_ordinal` to continue from when a section runs long. Only fall back to `file_read` for genuinely short documents, or when the outline says there are no indexed passages.",
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description:
          'the document node — the `nodeId` from a search_chunks hit, or any file/page id',
      },
      heading: {
        type: 'string',
        description: 'read all passages whose heading path contains this text (case-insensitive)',
      },
      from_ordinal: {
        type: 'integer',
        minimum: 0,
        description: 'start of an ordinal range (inclusive)',
      },
      to_ordinal: {
        type: 'integer',
        minimum: 0,
        description: 'end of an ordinal range (inclusive); defaults to from_ordinal',
      },
      max_chars: {
        type: 'integer',
        minimum: 2000,
        maximum: 60000,
        description: 'cap on returned characters (default 24000)',
      },
    },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    const nodeId = str(input.node_id);
    if (!nodeId) return { ok: false, error: 'node_id required' };
    const res = await readSection({
      ownerId: ctx.ownerId,
      nodeId,
      heading: strOpt(input.heading),
      fromOrdinal: num(input.from_ordinal),
      toOrdinal: num(input.to_ordinal),
      maxChars: num(input.max_chars),
    });
    if ('error' in res) return { ok: false, error: res.error };
    ctx.step?.setOutput(
      res.mode === 'outline'
        ? { mode: 'outline', passages: res.totalPassages, sections: res.sections.length }
        : {
            mode: 'section',
            passages: res.passages,
            chars: res.text.length,
            truncated: res.truncated,
          },
    );
    return { ok: true, output: res };
  },
};

const tree_list: BuiltinToolDef = {
  slug: 'tree_list',
  name: 'List tree children',
  description:
    "List children of a branch in the user's tree (the universal navigator — whatever kinds of nodes live under that branch). Pass `path` to scope (ltree, e.g. 'files.work'). Omit for top-level branches. " +
    'For files specifically use `file_list`; for folders use `folder_list`; for searching by content/topic use `search_nodes` (or `search_chunks` to pull the relevant passages from inside documents).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'parent ltree path; omit for top-level' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 100,
        description: 'Max results to return.',
      },
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
    'Resolve a name or alias to entities the user has accumulated (people, projects, places, orgs, events). Returns hits with similarity scores. Use this when the user mentions someone or something by name and you need their internal id.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'name or alias to resolve' },
      kind: {
        type: 'string',
        description: 'optional kind filter',
        enum: ['person', 'project', 'place', 'org', 'event'],
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Max results to return.',
      },
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
      entity_id: {
        type: 'string',
        format: 'uuid',
        description: "The entity's id (UUID) — from `entity_search`.",
      },
      relation: {
        type: 'string',
        description: "only follow edges with this relation verb, e.g. 'employed_by'; omit for all",
      },
      direction: {
        type: 'string',
        enum: ['in', 'out', 'both'],
        default: 'both',
        description:
          "'out' = edges where this entity is the subject, 'in' = where it is the object",
      },
      current_only: {
        type: 'boolean',
        default: false,
        description:
          'only relationships still current — exclude ones that have ended (superseded edges)',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25,
        description:
          "Max results to return. On 'both' the budget splits per direction, so odd values can return one extra row.",
      },
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
      max_depth: {
        type: 'integer',
        minimum: 1,
        maximum: 6,
        default: 3,
        description: 'How many hops out to traverse.',
      },
      relations: {
        type: 'array',
        items: { type: 'string' },
        description: "Only follow these relation verbs, e.g. ['employed_by','owns'].",
      },
      directed: {
        type: 'boolean',
        default: false,
        description:
          'Follow edges subject→object only. Default false treats edges as undirected — the right setting for "how are X and Y connected" questions.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Max results to return.',
      },
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
    'All facts the user has accumulated about a specific entity (what they KNOW about that person/place/thing). Returns currently-valid facts by default; set include_retired=true to see superseded history. ' +
    'Get the entity id from `entity_search` first. For content nodes (emails, notes, files) that MENTION the entity use `entity_mentions`; to walk to connected entities use `entity_neighbors`.',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        format: 'uuid',
        description: "The entity's id (UUID) — from `entity_search`.",
      },
      include_retired: {
        type: 'boolean',
        default: false,
        description: 'also return superseded facts (the history), not just currently-valid ones',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 50,
        description: 'Max results to return.',
      },
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
    'Content nodes (files, notes, emails, …) that mention a given entity, newest first. Returns title + per-node summary so the model can decide which to dig into. ' +
    'Get the entity id from `entity_search` first. For distilled facts ABOUT the entity (what the user knows) use `entity_facts`; to walk to connected entities use `entity_neighbors`.',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        format: 'uuid',
        description: "The entity's id (UUID) — from `entity_search`.",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25,
        description: 'Max results to return.',
      },
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

const brain_capacity: BuiltinToolDef = {
  slug: 'brain_capacity',
  name: 'Check brain capacity',
  description:
    "Corpus size vs the split policy: document and passage-vector counts with a zone per axis — 'green' (no action), 'watch' (run recall checks, identify the growing category), 'split' (break the dominant category into a federated breakout brain). Use for capacity/health checks and scheduled monitoring; alert the user when the zone is not green. Read-only.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    const capacity = await corpusCapacity(ctx.ownerId);
    ctx.step?.setMeta({ zone: capacity.zone, pct_of_split: capacity.pctOfSplit });
    return { ok: true, output: capacity };
  },
};

// ─── files / folders ──────────────────────────────────────────────────────

const folder_list: BuiltinToolDef = {
  slug: 'folder_list',
  name: 'List folders',
  description:
    "List folders (only) in the user's host-mirrored filesystem. Pass `parent` (ltree path, e.g. 'files.work') for that folder's immediate sub-folders; pass `tree: true` for every folder under the root. " +
    "For files inside a folder use `file_list`; for a file's actual content use `file_read`; for searching files by content/topic use `search_nodes` with `type='file'` (or `search_chunks` to pull the relevant passages from inside them).",
  inputSchema: {
    type: 'object',
    properties: {
      parent: {
        type: 'string',
        description:
          "ltree path of the folder whose immediate sub-folders to list, e.g. 'files.work'; defaults to the 'files' root",
      },
      tree: {
        type: 'boolean',
        default: false,
        description: 'return every folder under the root (the whole tree) instead of one level',
      },
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
    "For sub-folders within that folder use `folder_list`; for a file's actual content use `file_read`; for searching files by content/topic across the whole tree use `search_nodes` with `type='file'` (or `search_chunks` to pull the relevant passages from inside them).",
  inputSchema: {
    type: 'object',
    properties: {
      parent_path: {
        type: 'string',
        description:
          "ltree path of the folder whose files to list, e.g. 'files.work.lister-printer' — from `folder_list`",
      },
    },
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
    'Universal reader — read the full content of any node by id. Returns title, type, tags, path, summary, and the full `data` blob (markdown body for notes, body+location+starts_at for events, status+due_at for tasks, etc.). ' +
    '**Prefer type-specific readers when available** — `note_get` / `event_get` / `task_get` / `page_get` / `email_get` — they return cleaner shapes for their type. ' +
    "For nodes of `type='file'` the body lives in object storage — use `file_read` instead. This tool is the fallback that works for any node type (incl. secret, sermon, contact, telegram_message). " +
    'Returns a `url` permalink — link the item as a markdown `[title](url)` when you reference it to the user.',
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: "The node's id (UUID) — from `search_nodes` / `tree_list` or any list tool.",
      },
    },
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
        supersededBy: nodes.supersededBy,
        supersededReason: nodes.supersededReason,
        createdAt: nodes.createdAt,
        updatedAt: nodes.updatedAt,
      })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
      .limit(1);
    if (!row)
      return {
        ok: false,
        error:
          'node not found — the id may be stale or mistyped; find it with search_nodes / tree_list, then re-issue.',
      };
    ctx.step?.setOutput({ type: row.type });
    // Content-currency annotation: reading a superseded node names its living
    // successor so stale content is never presented as current.
    const succ = row.supersededBy
      ? (await resolveSupersededTargets(ctx.ownerId, [row.id])).get(row.id)
      : undefined;
    return {
      ok: true,
      output: {
        id: row.id,
        type: row.type,
        title: row.title,
        path: row.path,
        tags: row.tags,
        url: nodeUrl(row.id),
        data: row.data,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        ...(succ
          ? {
              superseded_by: {
                id: succ.id,
                title: succ.title,
                url: nodeUrl(succ.id),
                note: 'SUPERSEDED — prefer this successor; do not present the old copy as current.',
              },
            }
          : {}),
        // A bare mark (or a dangling successor) has no pointer to offer but
        // must still read as outdated.
        ...(row.supersededReason && !succ
          ? {
              superseded: {
                reason: row.supersededReason,
                note: 'MARKED OUTDATED — no living successor recorded; treat the content with caution.',
              },
            }
          : {}),
      },
    };
  },
};

const content_supersede: BuiltinToolDef = {
  slug: 'content_supersede',
  name: 'Mark content superseded',
  description:
    'Mark a node OUTDATED, optionally naming its replacement — the old copy is down-weighted in retrieval, and when a replacement is named every future hit on it carries a "superseded by" pointer to the successor (a bare mark down-weights only). Returns the updated mark. ' +
    'Use when the user says content is stale, wrong, or replaced ("this file is outdated — the page is the current version"). For deleting content outright use the type\'s delete tool instead; this is the reversible, history-preserving move. ' +
    'Pass `clear: true` to un-mark (restores full weight); omit `superseded_by` for a bare outdated mark. ' +
    '`page_from_file` / `page_from_note` stamp this automatically; use this for corrections and lineage the system could not see.',
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description:
          'the outdated node (file, page, note, … — not emails or folders; those are refused)',
      },
      superseded_by: {
        type: 'string',
        format: 'uuid',
        description:
          'the node that replaces it, e.g. the corrected page built from a stale file; omit for a bare "outdated" mark',
      },
      reason: {
        type: 'string',
        enum: ['version', 'migrated', 'corrected'],
        default: 'corrected',
        description:
          "why: 'migrated' (content moved to the successor), 'corrected' (the old content is wrong — demotes harder), 'version' (an older export of the same artifact)",
      },
      clear: {
        type: 'boolean',
        default: false,
        description: 'un-mark instead: clear the supersession and restore full retrieval weight',
      },
    },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    // Members must not re-weight the owner's brain: curation is an owner-side
    // action (mirrors the other owner-only tools' team-surface refusal).
    if (ctx.surface?.kind === 'team' || ctx.surface?.kind === 'forum') {
      return {
        ok: false,
        error:
          'content_supersede is owner-side only — on the team surface, ask the owner (or file a request with team_request_create) instead of re-weighting content directly.',
      };
    }
    const nodeId = str(input.node_id).trim();
    if (!nodeId) return { ok: false, error: 'node_id required' };
    try {
      if (input.clear === true) {
        const row = await unsupersedeNode(ctx.ownerId, nodeId);
        ctx.step?.setOutput({ id: row.id, cleared: true });
        return {
          ok: true,
          output: { id: row.id, title: row.title, cleared: true },
        };
      }
      const successorId = str(input.superseded_by).trim() || null;
      const reason = (strOpt(input.reason) ?? 'corrected') as 'version' | 'migrated' | 'corrected';
      const row = await supersedeNode({
        ownerId: ctx.ownerId,
        id: nodeId,
        supersededBy: successorId,
        reason,
      });
      ctx.step?.setOutput({ id: row.id, superseded_by: successorId, reason });
      return {
        ok: true,
        output: {
          id: row.id,
          title: row.title,
          superseded_by: row.supersededBy,
          reason: row.supersededReason,
          note: 'Down-weighted in retrieval (reversible with clear: true) — not deleted.',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('successor node not found')) {
        return {
          ok: false,
          error: `superseded_by '${str(input.superseded_by)}' is not one of the user's nodes — find the replacement's id with search_nodes / page_list, then re-issue.`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const SECRET_KIND_VALUES = ['password', 'token', 'server', 'card', 'note', 'other'] as const;

const SECRETS_ROOT_LABEL = 'secrets';

const secret_create: BuiltinToolDef = {
  slug: 'secret_create',
  name: 'Capture a secret',
  description:
    "Capture a sensitive value — password, PIN, API key, recovery code, anything the user explicitly says is private — into the encrypted /secrets store. ALWAYS prefer this over `note_create` or `file_create` for a dictated credential: a note stores it in plaintext where any future tool call can read it, while this seals the value behind a key only the owner's browser session can unlock. The value is REDACTED in trace logs — never echo it back to the user; confirm by title only ('saved your safe PIN'). For multi-field secrets (e.g. a server with both username and password) the /secrets UI is still the right path; this handles the common one-value case.",
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
        description:
          'optional plaintext metadata visible to search (do NOT include the value here)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
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
    const kind = (SECRET_KIND_VALUES as readonly string[]).includes(kindRaw) ? kindRaw : 'other';

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
        url: nodeUrl(inserted.id),
        title: inserted.title,
        kind,
        message:
          'Saved to /secrets. The value is sealed — confirm by title only, do not repeat it back to the user.',
      },
    };
  },
};

/** A file's extracted text past this many chars is "large": dumping it whole
 *  overflows the 32KB tool-result ceiling, spills, and gets re-sent every loop
 *  iteration (the dominant token sink). Past it, an INDEXED file returns its
 *  opening + a section outline + a pointer to read_section instead — unless the
 *  caller forces it with full:true, or there are no chunks to navigate by. */
const FILE_LARGE_TEXT_CHARS = 24000;
/** How much of the opening to show when the large-document guard fires. */
const FILE_HEAD_CHARS = 4000;

const file_read: BuiltinToolDef = {
  slug: 'file_read',
  name: 'Read a file',
  description:
    "Read a file's content by id. For text files (.md / .txt / .json / .yaml) returns the body as a utf-8 string. For binaries the extractor stores the parsed text (PDF / Word / Excel) as `data.text`, returned here so you can read or quote the document's actual contents. Returns `content: null` only when no text could be extracted (e.g. a scanned image with no OCR). " +
    '**For a LARGE indexed document this returns the opening + a section outline, NOT the whole text** — to read a specific part, use `search_chunks` + `read_section`; pass `full: true` only when you truly need every word. Use `node_read` for notes/events/tasks/secrets.',
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
      full: {
        type: 'boolean',
        description:
          'Load the ENTIRE extracted text even when the document is large. Default false: a large, indexed document returns its opening + a section outline + a pointer to read_section (almost always what you want). Set true only when you genuinely need the complete text.',
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const full = bool(input.full) === true;
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta)
      return {
        ok: false,
        error: 'file not found — find the right id with file_list / search_nodes, then re-issue.',
      };

    // Resolve the readable text once. Binary (pdf/docx/xlsx): the raw bytes
    // aren't useful to the LLM, but the extractor persists the parsed text as
    // data.text. Text files: the utf-8 body.
    let text: string | null;
    if (!meta.isText) {
      const [n] = await db
        .select({ data: nodes.data })
        .from(nodes)
        .where(and(eq(nodes.id, meta.id), eq(nodes.ownerId, ctx.ownerId)))
        .limit(1);
      text =
        n && typeof (n.data as Record<string, unknown>)?.text === 'string'
          ? ((n.data as Record<string, unknown>).text as string)
          : null;
    } else {
      const res = await readFileById({ ownerId: ctx.ownerId, fileId });
      if (!res)
        return {
          ok: false,
          error: 'file not found — find the right id with file_list / search_nodes, then re-issue.',
        };
      text = res.bytes.toString('utf8');
    }

    // Large-document guard: a big, already-chunked file would spill into the
    // tool-result store and get re-sent every loop iteration. Return the
    // opening + a section outline + a pointer to read_section instead — unless
    // forced with full:true, or there are no chunks to navigate by (then the
    // full text is the only option, returned as before).
    if (!full && text && text.length > FILE_LARGE_TEXT_CHARS) {
      const chunkRows = await db
        .select({ ordinal: contentChunks.ordinal, heading: contentChunks.headingPath })
        .from(contentChunks)
        .where(and(eq(contentChunks.nodeId, meta.id), eq(contentChunks.ownerId, ctx.ownerId)))
        .orderBy(asc(contentChunks.ordinal));
      if (chunkRows.length > 0) {
        const sections = buildSectionOutline(chunkRows);
        ctx.step?.setOutput({
          large: true,
          totalChars: text.length,
          passages: chunkRows.length,
          sections: sections.length,
        });
        return {
          ok: true,
          output: {
            file: meta,
            content: text.slice(0, FILE_HEAD_CHARS),
            truncated: true,
            total_chars: text.length,
            indexed_passages: chunkRows.length,
            sections: sections.slice(0, 100),
            note:
              `This document is large (${text.length} chars, ${chunkRows.length} indexed passages); only the opening ${FILE_HEAD_CHARS} chars are shown. ` +
              `To read a specific part WITHOUT loading the whole file, use search_chunks to find the passage, then read_section(node_id:"${meta.id}", heading|from_ordinal..to_ordinal) to read that section in full. ` +
              `Call file_read again with full:true ONLY if you genuinely need the entire text.`,
          },
        };
      }
    }

    ctx.step?.setOutput({
      binary: !meta.isText,
      hasExtractedText: !!text,
      textChars: text?.length ?? 0,
    });
    return { ok: true, output: { file: meta, content: text } };
  },
};

const file_get: BuiltinToolDef = {
  slug: 'file_get',
  name: 'Fetch file metadata',
  description:
    "Fetch a file's metadata (filename, mime type, size, sha) — no bytes. Use to confirm size/type before deciding to read a large/binary file. " +
    'For the actual file content use `file_read`; for listing files in a folder use `file_list`.',
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const row = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!row)
      return {
        ok: false,
        error: 'file not found — find the right id with file_list / search_nodes, then re-issue.',
      };
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
    properties: {
      path: {
        type: 'string',
        description: "the folder's full ltree path, e.g. 'files.work.lister-printer'",
      },
    },
    required: ['path'],
  },
  handler: async (input, ctx) => {
    const path = str(input.path);
    if (!path) return { ok: false, error: 'path required' };
    const row = await folderByPath({ ownerId: ctx.ownerId, path });
    if (!row)
      return {
        ok: false,
        error: 'folder not found — find the right id with folder_list / tree_list, then re-issue.',
      };
    return { ok: true, output: row };
  },
};

const file_create: BuiltinToolDef = {
  slug: 'file_create',
  name: 'Create / overwrite a file',
  description:
    'Create or overwrite a **named text file** in a specific folder (e.g. `notes.md`, `config.json`, `recipe.txt`). Use when the user asks for a file with a particular name/extension in a particular place. Filename is lowercased and sanitised automatically. ' +
    'For a plain note that goes into /notes (no filename/folder needed, auto-indexed) use `note_create`. For credentials/passwords use `secret_create`. For a rich-text doc (TipTap) use `page_create`.',
  requiresConfirm: false, // text-only writes are usually safe; user can flip per agent
  inputSchema: {
    type: 'object',
    properties: {
      parent_path: { type: 'string', description: 'ltree path of the parent folder' },
      filename: { type: 'string', description: 'with extension, e.g. notes.md' },
      content: {
        type: 'string',
        description: "the file's full text — becomes the entire body (replaces, never appends)",
      },
      overwrite: {
        type: 'boolean',
        default: false,
        description:
          'replace the existing file of the same name; default false errors on a name collision',
      },
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

const file_rename: BuiltinToolDef = {
  slug: 'file_rename',
  name: 'Rename a file',
  description:
    "Rename a file in place — its folder and extension are kept, only the basename changes. `new_stem` is the new name WITHOUT the extension (e.g. rename `huntsman-report.xlsx` → stem `customerx-report`). Find the file id with `file_list` / `search_nodes` first. To change a file's CONTENTS use `file_create` with overwrite=true; to rename a FOLDER use `folder_rename`.",
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
      new_stem: { type: 'string', description: 'new basename, no extension' },
    },
    required: ['file_id', 'new_stem'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    const newStem = str(input.new_stem);
    if (!fileId || !newStem) return { ok: false, error: 'file_id + new_stem required' };
    try {
      const row = await renameFileById({ ownerId: ctx.ownerId, fileId, newStem });
      if (!row)
        return {
          ok: false,
          error: 'file not found — find the right id with file_list / search_nodes, then re-issue.',
        };
      ctx.step?.setOutput({ fileId: row.id, filename: row.filename });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const folder_rename: BuiltinToolDef = {
  slug: 'folder_rename',
  name: 'Rename a folder',
  description:
    "Rename a folder in place. `new_name` is lowercased and sanitised automatically. Every file and sub-folder inside moves with it (their paths update), so this is safe for a folder full of content. Find the folder id with `folder_list` / `folder_get_by_path` first. The root `files` folder can't be renamed. To change a folder's DESCRIPTION use `folder_describe`.",
  preconditions: FOLDER_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: {
        type: 'string',
        format: 'uuid',
        description: "The folder's id (UUID) — from `folder_list` / `folder_get_by_path`.",
      },
      new_name: {
        type: 'string',
        description:
          "new display name, e.g. 'lister contracts' — lowercased and slugified automatically",
      },
    },
    required: ['folder_id', 'new_name'],
  },
  handler: async (input, ctx) => {
    const folderId = str(input.folder_id);
    const newName = str(input.new_name);
    if (!folderId || !newName) return { ok: false, error: 'folder_id + new_name required' };
    try {
      const row = await renameFolderById({ ownerId: ctx.ownerId, folderId, newSlug: newName });
      if (!row)
        return {
          ok: false,
          error:
            'folder not found — find the right id with folder_list / tree_list, then re-issue.',
        };
      ctx.step?.setOutput({ folderId: row.id, path: row.path });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const folder_describe: BuiltinToolDef = {
  slug: 'folder_describe',
  name: 'Update a folder description',
  description:
    "Set or update a folder's free-text description (what the folder is for). Find the folder id with `folder_list` / `folder_get_by_path` first. This does NOT rename the folder — use `folder_rename` for that.",
  preconditions: FOLDER_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: {
        type: 'string',
        format: 'uuid',
        description: "The folder's id (UUID) — from `folder_list` / `folder_get_by_path`.",
      },
      description: {
        type: 'string',
        description:
          "what the folder is for, e.g. 'Signed Lister contracts and quotes' — replaces any existing description",
      },
    },
    required: ['folder_id', 'description'],
  },
  handler: async (input, ctx) => {
    const folderId = str(input.folder_id);
    const description = str(input.description);
    if (!folderId) return { ok: false, error: 'folder_id required' };
    try {
      const row = await updateFolderDescription({ ownerId: ctx.ownerId, folderId, description });
      if (!row)
        return {
          ok: false,
          error:
            'folder not found — find the right id with folder_list / tree_list, then re-issue.',
        };
      ctx.step?.setOutput({ folderId: row.id });
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
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: 'optional single node to re-extract',
      },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'optional node-type filter (e.g. ["file","note"])',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
        default: 100,
        description: 'Max nodes to re-signal in one sweep.',
      },
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
    const typeFilter = Array.isArray(input.types) ? (input.types as string[]) : null;
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
      text: {
        type: 'string',
        minLength: 1,
        description: 'the message body to send — plain text unless `markdown` is set',
      },
      reply_to: { type: 'string', description: 'optional telegram_message_id to thread under' },
      markdown: {
        type: 'boolean',
        default: false,
        description: 'render the text as Telegram MarkdownV2 instead of plain text',
      },
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
      .where(and(eq(telegramChats.userId, ctx.ownerId), eq(telegramChats.telegramChatId, chatId)))
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
    "Hand off a single, self-contained prompt to another agent (e.g. a researcher with a stronger model + retrieval tools). Use only when the work would clearly benefit from a different persona or model — not for routing every turn. The child runs once and returns its final text; its conversation history is NOT shared with the parent. Pack the prompt to stand alone: the user's ask (their words, not a paraphrase), the exact node ids via `subject_node_ids`, any composed content IN FULL, and what 'done' looks like. The runtime also attaches the triggering user message automatically as a safety net. The parent agent's `memory_config.delegate_to` must list the target slug, or this call is refused.",
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
          'Self-contained instructions for the child. Include any context it needs; the child does not see your conversation history. State the goal, the material (in full — never shortened), and the expected end state.',
        maxLength: 32_000,
      },
      subject_node_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Ids of the nodes (pages, tables, files) the child should operate on. Always pass these when the work targets existing content — a child that has to SEARCH for its subject can pick the wrong one.',
      },
    },
  },
  handler: async (input, ctx) => {
    // Lazy imports keep the guard module + bridge out of the cold-
    // start path of every other builtin. They're tiny but the
    // separation lets us test them as pure helpers.
    const { MAX_AGENT_DEPTH, checkAgentDepth, checkDelegationAllowed, isTerminalDelegateConfig } =
      await import('./invoke-agent-guards');
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
    const allowed = checkDelegationAllowed(ctx.agent.slug, targetSlug, ctx.agent.delegateTo);
    if (!allowed.ok) return { ok: false, error: allowed.reason };

    // Guardrail 1: bounded depth. One sanctioned exception (see
    // invoke-agent-guards.ts): a child may go a single level deeper along its
    // declared edge to a TERMINAL specialist — no delegates of its own, so the
    // chain provably ends there (the appsmith → toolsmith hop mid app build).
    // The lookup only runs when the base cap would refuse; a missing/disabled
    // target fails closed to non-terminal and the plain cap applies.
    let targetIsTerminal = false;
    if (ctx.agent.depth + 1 > MAX_AGENT_DEPTH) {
      const [targetRow] = await db
        .select({ memoryConfig: agents.memoryConfig })
        .from(agents)
        .where(
          and(
            eq(agents.ownerId, ctx.ownerId),
            eq(agents.slug, targetSlug),
            eq(agents.enabled, true),
          ),
        )
        .limit(1);
      const dt = (targetRow?.memoryConfig as { delegate_to?: unknown } | null)?.delegate_to;
      targetIsTerminal = !!targetRow && isTerminalDelegateConfig(dt);
    }
    const depth = checkAgentDepth(ctx.agent.depth, { targetIsTerminal });
    if (!depth.ok) return { ok: false, error: depth.reason };

    const invoker = getAgentInvoker();
    if (!invoker) {
      return {
        ok: false,
        error:
          'invoke_agent: no agent invoker registered in this process. Call registerAgentInvoker() at boot.',
      };
    }

    // Auto-bundled delegation context (2026-07-18 delegation review): the
    // child sees ONLY this prompt, and under-packed prompts are the hand-off's
    // main miscommunication gap. Attach the explicit subject ids and the
    // user's verbatim ask mechanically instead of trusting every parent to
    // pack well. The verbatim ask is skipped when the parent already quoted
    // it (no point doubling it).
    const subjectIds = Array.isArray(input.subject_node_ids)
      ? (input.subject_node_ids as unknown[])
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .slice(0, 20)
      : [];
    const envelope: string[] = [];
    if (subjectIds.length) {
      envelope.push(
        `Subject node ids (operate on exactly these; do not search for others): ${subjectIds.join(', ')}`,
      );
    }
    const userAsk = ctx.agent.lastUserMessage?.trim();
    if (userAsk && !prompt.includes(userAsk)) {
      const clipped = userAsk.length > 4000 ? `${userAsk.slice(0, 4000)} …[truncated]` : userAsk;
      envelope.push(
        `The user's verbatim message that triggered this delegation (ground truth for intent):\n"""\n${clipped}\n"""`,
      );
    }
    const childPrompt = envelope.length
      ? `${prompt}\n\n--- delegation context (attached automatically by the runtime) ---\n${envelope.join('\n\n')}`
      : prompt;

    // Guardrail 2: synchronous. Await the child's final result. The
    // child's cost is captured in the child's own trace; we surface
    // it in the parent step's meta for /traces visibility, but the
    // parent's `traces.cost_micro_usd` does NOT roll it up — that
    // would double-count in /debug aggregates.
    const result = await invoker({
      ownerId: ctx.ownerId,
      agentSlug: targetSlug,
      prompt: childPrompt,
      depth: depth.childDepth,
      parentTraceId: ctx.agent.parentTraceId ?? null,
      // Inherit the parent turn's thinking budget; the child re-clamps it.
      ...(ctx.agent.thinkingBudget ? { thinkingBudget: ctx.agent.thinkingBudget } : {}),
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
  read_section,
  tree_list,
  entity_search,
  entity_neighbors,
  graph_path,
  entity_facts,
  entity_mentions,
  brain_capacity,
  folder_list,
  folder_get_by_path,
  file_list,
  file_get,
  file_read,
  node_read,
  content_supersede,
  secret_create,
  file_create,
  file_rename,
  folder_rename,
  folder_describe,
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
  // Task CRUD — mirrors the MCP task tools so Saskia can capture and
  // manage tasks from chat. None require_confirm (trivially reversible).
  ...TASK_TOOLS,
  ...TEAM_TOOLS,
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
  // Generic sharing — mint/revoke a viewable link for ANY shareable item
  // (note/task/event/file/app/table/folder); the type-agnostic counterpart
  // of page_share. node_share is requires_confirm (publishes outward).
  ...SHARE_TOOLS,
  // Apps — Appsmith authors mini apps (TSX), builds them with esbuild, and
  // declares the api_tools/sqlite they use. app_delete + app_publish are the
  // admin subset; the broker enforces the per-app tool allowlist at runtime.
  ...APP_TOOLS,
  // App-data reads for the responder — query a mini app's SQLite (read-only).
  ...APP_DATA_TOOLS,
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
  // Journal — the user's first-person self-knowledge (who they are, work,
  // family, feelings). Source of the always-on identity context. Saskia can
  // add/refine entries when the user shares something durable about themselves.
  ...JOURNAL_TOOLS,
  // Federation — query other people's Mantles for data they've shared with
  // you. Outbound half of docs/federation.md; reads only what a peer granted.
  ...PEER_TOOLS,
  // Retrieval-quality self-check (recall_eval) — heartbeat-driven monitoring.
  ...EVAL_TOOLS,
  // Toolsmith — author/test/group/grant templated HTTP API tools (+ web_fetch
  // for reading API docs). Granted to the Toolsmith specialist; mirrored over
  // MCP so Claude Code can drive the same flow. http-only by design.
  ...TOOLSMITH_TOOLS,
  // Profile — adjust time-aware preferences (timezone) in-conversation, so a
  // travelling user's "Current time" stays right without a trip to Settings.
  ...PROFILE_TOOLS,
  // Locations — the local half of geo awareness: save a resolved place, find
  // saved places nearby (cache reader), haversine distance, and route_map (the
  // one that calls Mapbox — renders a route polyline to an inline PNG artifact).
  // Reverse-geocoding / search / directions are seeded Mapbox HTTP tools.
  ...LOCATION_TOOLS,
  // Export — render a page/note to Word (.docx) or a table to Excel (.xlsx) and
  // save it under /files/exports. Shares @mantle/content's resolveExport with
  // the web download button, so the assistant and the UI emit identical files.
  ...EXPORT_TOOLS,
  // Runner queues — durable, inspectable execution plans (docs/runs.md).
  // Responder-only via the `runs` tool group; creation gated by MANTLE_RUNS.
  ...RUN_TOOLS,
];

// P6: there is no flat "default assistant grant" anymore. A generalist persona's
// capability is the union of its granted tool GROUPS (the manifest persona's
// `toolGroupSlugs`; see apps/web/lib/system-manifest/manifest.ts). The old
// DEFAULT_ASSISTANT_TOOL_SLUGS / ASSISTANT_TOOL_DENY pair was removed with the
// `agents.tool_slugs` column (migration 0083); the specialist/destructive split
// it encoded now lives in the group taxonomy (terminal / research / federation /
// recall-search groups + the `*-admin` delete groups).
