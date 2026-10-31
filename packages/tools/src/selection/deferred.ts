/**
 * Deferred tool loading: a cache-safe way to give an agent many tools.
 *
 * The model is sent a small, STABLE core of full tool definitions plus two
 * meta tools. Every other granted tool is listed by NAME in a catalog block
 * the loop appends to the first (cached) system block, grouped by flow. When the
 * model needs one, it calls `tool_search`; the full schemas come back as an
 * ordinary tool RESULT in the conversation tail. The `tools` array and the
 * catalog text never change inside a turn or between turns (for one grant), so
 * the cached prompt prefix survives. The catalog sits in the system prompt, not
 * in tool_search's description: on the bench that placement made models search
 * more often (Claude 89 vs 86 right first tool). The model then calls the tool by its own name or
 * through `use_tool`; the tool loop dispatches either against the real schema.
 *
 * Measured: 143 tools = 58.5k Claude
 * tokens per call; this set = about 11k. Right first tool on a 101-case bench:
 * Claude 89 vs 91 (full list), Grok 90 vs 81.
 *
 * Pure: no database, no model. The tool loop owns dispatch and tracing.
 */

import { CORE_TOOL_SLUGS } from './core';
import { TOOL_FLOWS } from './flows';
import { tableBuiltins } from '../tool-policy';
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
/** The tool map's meta tools (map.ts), named here so unwrapUseTool knows
 *  every wrapper and never wraps one in another. */
export const TOOL_CALL_SLUG = 'tool_call';
export const TOOL_HELP_SLUG = 'tool_help';
/** The names each mode's loop takes as its own: deferred loading's two,
 *  and the map's four (its own and deferred's, kept as aliases). */
export const DEFERRED_META_SLUGS: ReadonlySet<string> = new Set([TOOL_SEARCH_SLUG, USE_TOOL_SLUG]);
export const MAP_META_SLUGS: ReadonlySet<string> = new Set([
  TOOL_SEARCH_SLUG,
  USE_TOOL_SLUG,
  TOOL_CALL_SLUG,
  TOOL_HELP_SLUG,
]);

// The core (CORE_TOOL_SLUGS) lives in core.ts, its own file, so the
// architecture count can leave exactly it out.
export { CORE_TOOL_SLUGS } from './core';

/** Per-turn affordances (heartbeat continuity) stay in full: they are only
 *  present when a heartbeat is active, and the model must see them. */
const ALWAYS_FULL_PREFIXES = ['heartbeat_'];

/** The usage prior of `tool_search`: each builtin's own `usageTier`
 *  (BuiltinToolDef), as pseudo-usage 2^tier; a tool with none gets none.
 *  Read at each search, from the registry. */
export function toolUsagePrior(): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...tableBuiltins()].flatMap((d) =>
      d.usageTier === undefined ? [] : [[d.slug, 2 ** d.usageTier] as const],
    ),
  );
}

/** How many tools one search returns. */
export const TOOL_SEARCH_LIMIT = 6;
const SEARCH_DESCRIPTION_CHARS = 600;
/** Per-tool "what it does" line in the catalog. On the bench, names alone
 *  let Claude reach for search_nodes instead of the specific tool. */
const CATALOG_SUMMARY_CHARS = 90;

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
  /** Text the loop appends to the first (cached) system block: the rule and
   *  the names-only catalog. Stable for a given grant. */
  systemBlock: string;
  /** Rank the deferred tools for a query; returns the tool_search result. */
  search: (query: string, flow?: string) => ToolSearchResult;
};

export type ToolSearchResult = {
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  note: string;
};

/** Who wrote a tool's description: Mantle's code, the brain's owner (an http
 *  tool authored on this brain, e.g. by Toolsmith), or someone else: an MCP
 *  connector's server, an OpenAPI spec an http tool was compiled from
 *  (`handler.openapi`), or anything not known to be safe (recipes included,
 *  for now). Only builtin and owner descriptions reach the catalog. */
export type ToolSource = 'builtin' | 'owner' | 'remote';

export function toolSourceOf(handler: unknown): ToolSource {
  const h = (handler ?? {}) as { kind?: unknown; openapi?: unknown };
  if (h.kind === 'builtin') return 'builtin';
  if (h.kind === 'http' && h.openapi == null) return 'owner';
  return 'remote';
}

export function isAlwaysFull(slug: string): boolean {
  return CORE_TOOL_SLUGS.includes(slug) || ALWAYS_FULL_PREFIXES.some((p) => slug.startsWith(p));
}

// Tested: with this rule Grok called tool_search in 24 of 30 dev probe
// turns, often for information it then fetched with search_nodes. Two softer
// openings ("tool_search only for an ACTION ...; for INFORMATION use
// search_nodes") cut Claude's right-first-tool score on the bench by 2 to 3
// cases of 101 and did not help Grok, so this wording stays.
const SEARCH_RULE =
  'The catalog tools are yours: never say you cannot do a task, and never answer a task without ' +
  'acting, before you have checked the catalog and loaded the tool with tool_search. A general ' +
  'tool (search_nodes, search_chunks, file_read, page_list) is not a stand-in for a specific ' +
  'one. When the request is about contacts, notes, folders, entities, the graph, images, video, ' +
  'speech, your own persona or style, Recall maps, email, events, tasks, journal, sharing, ' +
  'formulas, apps or places, look at the catalog first: if a listed tool does that action, load ' +
  'it with tool_search before you act.';

const TOOL_SEARCH_DEF: DeferredToolDef = {
  type: 'function',
  function: {
    name: TOOL_SEARCH_SLUG,
    description:
      'Load tools that are listed in the tool catalog but not yet loaded. Describe the action you ' +
      `need in plain words (and optionally the flow). Returns up to ${TOOL_SEARCH_LIMIT} matching ` +
      'tools with their full input schemas. Then call the tool through use_tool.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The action you need, e.g. "send an email".' },
        flow: {
          type: 'string',
          description: 'Optional flow or group slug from the catalog (the word after ### or -).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

/** The catalog block for the cached system prompt (stable per grant). */
function catalogBlock(catalog: string): string {
  return (
    '## Tool catalog\nYou hold the core tools directly. Every other tool you are granted is listed ' +
    'below by name, grouped by flow. To use one, call tool_search with what you need, then call ' +
    `it with use_tool.\nRule: ${SEARCH_RULE}\n${catalog}`
  );
}

const USE_TOOL_DEF: DeferredToolDef = {
  type: 'function',
  function: {
    name: USE_TOOL_SLUG,
    description:
      'Call a catalog tool whose schema you loaded with tool_search. `name` is the tool name; ' +
      '`arguments` must match its input schema.',
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
 * The granted tools a lazy mode (deferred, map) sends in full, and the rest.
 * Core first in CORE_TOOL_SLUGS order; heartbeat affordances after, in grant
 * order (Array.prototype.sort is stable). `rest` keeps grant order.
 */
export function splitCore(defs: readonly DeferredToolDef[]): {
  core: DeferredToolDef[];
  rest: DeferredToolDef[];
} {
  const rank = (name: string) => {
    const i = CORE_TOOL_SLUGS.indexOf(name);
    return i < 0 ? CORE_TOOL_SLUGS.length : i;
  };
  const core = defs
    .filter((d) => isAlwaysFull(d.function.name))
    .sort((a, b) => rank(a.function.name) - rank(b.function.name));
  return { core, rest: defs.filter((d) => !isAlwaysFull(d.function.name)) };
}

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
  /** Who wrote each tool's description (toolSourceOf). With a map, a tool it
   *  does not name counts as remote (names only); without one, every tool is
   *  treated as code-authored. */
  sources?: ReadonlyMap<string, ToolSource>,
): DeferredToolset | null {
  const { core, rest } = splitCore(defs);
  if (rest.length === 0) return null;
  const defBy = new Map(rest.map((d) => [d.function.name, d]));
  const sortedGroups = [...groups].sort((a, b) => a.slug.localeCompare(b.slug));
  const cards: ToolCard[] = buildToolCards(
    rest.map((d) => ({
      slug: d.function.name,
      description: d.function.description,
      authored: sources ? (sources.get(d.function.name) ?? 'remote') !== 'remote' : true,
    })),
    sortedGroups,
  );
  const index: CardIndex = indexCards(cards);
  const catalog = renderCatalog(cards, TOOL_FLOWS, new Set(), {
    summaryChars: CATALOG_SUMMARY_CHARS,
  });
  const search = (query: string, flow?: string): ToolSearchResult => {
    const usage = toolUsagePrior();
    let hits = rankTools(index, query, {
      usage,
      limit: TOOL_SEARCH_LIMIT,
      ...(flow ? { flow } : {}),
    });
    if (hits.length === 0 && flow) {
      hits = rankTools(index, query, { usage, limit: TOOL_SEARCH_LIMIT });
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
        ? 'Call one with use_tool.'
        : 'No match. Try other words, or name a flow from the catalog.',
    };
  };
  return {
    sent: [...core, TOOL_SEARCH_DEF, USE_TOOL_DEF],
    systemBlock: catalogBlock(catalog),
    deferred: new Set(rest.map((d) => d.function.name)),
    search,
  };
}

/**
 * Unwrap a `use_tool` call (or the map's `tool_call`, the same shape) into
 * the real tool call. `meta` is the mode's own tools (DEFERRED_META_SLUGS
 * or MAP_META_SLUGS). Returns the inner slug and its arguments as a JSON
 * string, or an error the model can act on.
 */
export function unwrapUseTool(
  argumentsRaw: string,
  wrapper: string = USE_TOOL_SLUG,
  /** The mode's meta tools, which a wrapper never calls. */
  meta: ReadonlySet<string> = DEFERRED_META_SLUGS,
): { ok: true; slug: string; argumentsRaw: string } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsRaw || '{}');
  } catch {
    return {
      ok: false,
      error: `${wrapper} arguments are not valid JSON. Send {"name": "<tool>", "arguments": {...}}.`,
    };
  }
  const o = (parsed ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof o.name !== 'string' || o.name.trim() === '') {
    return {
      ok: false,
      error:
        `${wrapper} needs \`name\`: the tool to call, ` +
        (wrapper === TOOL_CALL_SLUG ? 'as named in the tool map.' : 'as listed by tool_search.'),
    };
  }
  const name = o.name.trim();
  if (meta.has(name)) {
    return { ok: false, error: `${wrapper} cannot call ${name}; call it directly.` };
  }
  const inner = o.arguments === undefined ? {} : o.arguments;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    return {
      ok: false,
      error: `${wrapper} \`arguments\` must be an object matching ${name}'s input schema.`,
    };
  }
  return { ok: true, slug: name, argumentsRaw: JSON.stringify(inner) };
}
