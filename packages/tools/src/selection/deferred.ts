/**
 * Deferred tool loading: a cache-safe way to give an agent many tools.
 *
 * The model is sent a small, STABLE core of full tool definitions plus two
 * meta tools. Every other granted tool is listed by NAME in the catalog that
 * `tool_search` carries in its own description, grouped by flow. When the
 * model needs one, it calls `tool_search`; the full schemas come back as an
 * ordinary tool RESULT in the conversation tail. The `tools` array therefore
 * never changes inside a turn or between turns (for one grant), so the cached
 * prompt prefix survives. The model then calls the tool by its own name or
 * through `use_tool`; the tool loop dispatches either against the real schema.
 *
 * Measured 2026-10-05 (dev-brain plan page dab162c0): 143 tools = 58.5k Claude
 * tokens per call; this set = about 11k. Right first tool on a 101-case bench:
 * Claude 89 vs 91 (full list), Grok 90 vs 81.
 *
 * Pure: no database, no model. The tool loop owns dispatch and tracing.
 */

import { TOOL_FLOWS } from './flows';
import {
  buildToolCards,
  indexCards,
  rankTools,
  renderCatalog,
  summarize,
  type CardIndex,
  type GroupSource,
  type ToolCard,
} from './rank';

export const TOOL_SEARCH_SLUG = 'tool_search';
export const USE_TOOL_SLUG = 'use_tool';

/** Granted tools that are always sent in full: the tools that carry most
 *  turns on the fleet (a 20-tool core covered 54 to 86% of turns). A tool is
 *  core only if the agent is granted it; the list never adds a grant. Order
 *  is the grant's order, not this list's, so the prefix stays byte-stable. */
export const CORE_TOOL_SLUGS: readonly string[] = [
  'search_chunks',
  'search_nodes',
  'read_section',
  'read_result',
  'node_read',
  'page_get',
  'page_list',
  'page_blocks_list',
  'page_block_get',
  'page_block_update',
  'invoke_agent',
  'file_read',
  'file_list',
  'table_list',
  'table_schema',
  'table_sql',
  'event_list',
  'note_get',
  'note_create',
  'calculate',
];

/** Per-turn affordances (heartbeat continuity) stay in full: they are only
 *  present when a heartbeat is active, and the model must see them. */
const ALWAYS_FULL_PREFIXES = ['heartbeat_'];

/** Fleet call frequency order (90 days to 2026-10-05, four brains), used only
 *  as a tie-break prior in the ranker. Pseudo-usage = 1000 / (rank + 1). */
const USAGE_PRIOR_ORDER: readonly string[] = [
  'search_chunks',
  'search_nodes',
  'read_result',
  'page_block_get',
  'table_row_add',
  'read_section',
  'table_sql',
  'page_get',
  'page_blocks_list',
  'page_block_update',
  'file_read',
  'invoke_agent',
  'model_pool_set',
  'web_search',
  'table_schema',
  'page_list',
  'run_terminal',
  'node_read',
  'table_list',
  'page_block_insert_after',
  'app_file_write',
  'model_catalog',
  'app_db_query',
  'table_query',
  'app_get',
  'table_cell_set',
  'file_list',
  'app_db_list',
  'note_get',
  'page_create',
  'web_fetch',
  'event_list',
  'table_get',
  'folder_list',
  'show_image',
  'file_get',
  'page_blocks_apply',
  'table_rows_list',
  'recall_match',
  'table_from_file',
  'entity_search',
  'tool_catalog',
  'app_build',
  'tree_list',
  'team_request_create',
  'table_row_update',
  'page_block_append',
  'page_update_draft',
];
const USAGE_PRIOR: Readonly<Record<string, number>> = Object.fromEntries(
  USAGE_PRIOR_ORDER.map((s, i) => [s, 1000 / (i + 1)]),
);

/** How many tools one search returns. */
export const TOOL_SEARCH_LIMIT = 6;
const SEARCH_DESCRIPTION_CHARS = 600;

/** The OpenAI-compatible tool shape the chat adapters take. */
export type DeferredToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type DeferredToolset = {
  /** What the model is sent: core defs (grant order) + tool_search + use_tool. */
  sent: DeferredToolDef[];
  /** Granted tools that are NOT sent in full (reachable by search). */
  deferred: ReadonlySet<string>;
  /** Rank the deferred tools for a query; returns the tool_search result. */
  search: (query: string, flow?: string) => ToolSearchResult;
};

export type ToolSearchResult = {
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  note: string;
};

export function isAlwaysFull(slug: string): boolean {
  return CORE_TOOL_SLUGS.includes(slug) || ALWAYS_FULL_PREFIXES.some((p) => slug.startsWith(p));
}

const SEARCH_RULE =
  'A general tool (search_nodes, search_chunks, file_read, page_list) is not a stand-in for a ' +
  'specific one. When the request is about contacts, entities, the graph, images, speech, your ' +
  'own persona, Recall maps, tree folders, email, events, tasks, journal, sharing, formulas, apps ' +
  'or places, look at the catalog first: if a listed tool does that action, load it with ' +
  'tool_search before you act.';

function toolSearchDef(catalog: string, flows: readonly string[]): DeferredToolDef {
  return {
    type: 'function',
    function: {
      name: TOOL_SEARCH_SLUG,
      description:
        'Load granted tools that are listed in the catalog below but not yet loaded. Describe the ' +
        `action you need in plain words; returns up to ${TOOL_SEARCH_LIMIT} matching tools with ` +
        'their full input schemas. Then call the tool by its name, or through `use_tool`. The ' +
        `tools you already hold in full are not in the catalog.\n${SEARCH_RULE}\n\n` +
        `Tool catalog (by flow):\n${catalog}`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The action you need, e.g. "send an email" or "move a file to a folder".',
          },
          flow: {
            type: 'string',
            enum: [...flows],
            description: 'Optional flow from the catalog to search within.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  };
}

const USE_TOOL_DEF: DeferredToolDef = {
  type: 'function',
  function: {
    name: USE_TOOL_SLUG,
    description:
      'Call a catalog tool whose schema you loaded with `tool_search`. `name` is the tool name; ' +
      '`arguments` must match its input schema. Calling the tool directly by its name works too.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool name, e.g. "email_send".' },
        arguments: { type: 'object', description: "The tool's arguments." },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    },
  },
};

/**
 * Split a turn's full tool definitions into the sent set and the deferred
 * catalog. `defs` must be in grant order (as buildToolsForModel returns them);
 * `groups` give each tool its flow (any order; sorted by slug here so the
 * catalog does not depend on query order). Returns null when there is nothing
 * to defer, so the caller sends the full list unchanged.
 */
export function buildDeferredToolset(
  defs: readonly DeferredToolDef[],
  groups: readonly GroupSource[],
): DeferredToolset | null {
  const core = defs.filter((d) => isAlwaysFull(d.function.name));
  const rest = defs.filter((d) => !isAlwaysFull(d.function.name));
  if (rest.length === 0) return null;
  const defBy = new Map(rest.map((d) => [d.function.name, d]));
  const sortedGroups = [...groups].sort((a, b) => a.slug.localeCompare(b.slug));
  const cards: ToolCard[] = buildToolCards(
    rest.map((d) => ({ slug: d.function.name, description: d.function.description })),
    sortedGroups,
  );
  const index: CardIndex = indexCards(cards);
  const flows = [
    ...new Set(
      [...TOOL_FLOWS.map((f) => f.slug), 'other'].filter((f) => cards.some((c) => c.flow === f)),
    ),
  ];
  const catalog = renderCatalog(cards, TOOL_FLOWS);
  const search = (query: string, flow?: string): ToolSearchResult => {
    let hits = rankTools(index, query, {
      usage: USAGE_PRIOR,
      limit: TOOL_SEARCH_LIMIT,
      ...(flow ? { flow } : {}),
    });
    if (hits.length === 0 && flow) {
      hits = rankTools(index, query, { usage: USAGE_PRIOR, limit: TOOL_SEARCH_LIMIT });
    }
    const tools = hits.map((h) => {
      const d = defBy.get(h.slug)!;
      return {
        name: h.slug,
        description: summarize(d.function.description, SEARCH_DESCRIPTION_CHARS),
        input_schema: d.function.parameters,
      };
    });
    return {
      tools,
      note: tools.length
        ? 'Call one by its name, or through use_tool.'
        : 'No match. Try other words, or name a flow from the catalog.',
    };
  };
  return {
    sent: [...core, toolSearchDef(catalog, flows), USE_TOOL_DEF],
    deferred: new Set(rest.map((d) => d.function.name)),
    search,
  };
}

/**
 * Unwrap a `use_tool` call into the real tool call. Returns the inner slug and
 * its arguments as a JSON string, or an error the model can act on.
 */
export function unwrapUseTool(
  argumentsRaw: string,
): { ok: true; slug: string; argumentsRaw: string } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsRaw || '{}');
  } catch {
    return {
      ok: false,
      error: 'use_tool arguments are not valid JSON. Send {"name": "<tool>", "arguments": {...}}.',
    };
  }
  const o = (parsed ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof o.name !== 'string' || o.name.trim() === '') {
    return {
      ok: false,
      error: 'use_tool needs `name`: the tool to call, as listed by tool_search.',
    };
  }
  const name = o.name.trim();
  if (name === USE_TOOL_SLUG || name === TOOL_SEARCH_SLUG) {
    return { ok: false, error: `use_tool cannot call ${name}; call it directly.` };
  }
  const inner = o.arguments === undefined ? {} : o.arguments;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    return {
      ok: false,
      error: `use_tool \`arguments\` must be an object matching ${name}'s input schema.`,
    };
  }
  return { ok: true, slug: name, argumentsRaw: JSON.stringify(inner) };
}
