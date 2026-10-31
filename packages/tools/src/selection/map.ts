/**
 * Map tool loading (`tool_loading: 'map'`): every granted tool named, cheaply.
 *
 * Like deferred loading (deferred.ts), the model is sent the stable core in
 * full plus meta tools, and the rest goes in the first (cached) system block.
 * Here that block is a TOOL MAP: every other granted tool's name, written as
 * a compact grammar, one line per area (the slug's first word) with one
 * brain-authored gloss (areas.ts): `page (rich documents...): block(update)`
 * reads as `page_block_update`. The model calls any of them through
 * `tool_call {name, arguments}`, and reads a schema with `tool_help` when it
 * does not know the arguments; a call with wrong arguments gets the schema
 * back (the tool loop). `use_tool` and `tool_search` stay accepted as aliases.
 *
 * Bench of 2026-10-31 (101 cases, an assistant's grant): right first tool the
 * same as deferred within a case or two (Claude 88 to 90, Grok 90), and 22 to
 * 39% cheaper per turn. A names-only map (no glosses) lost cases. Small
 * models did worse than on deferred: keep them there.
 *
 * Pure: no database, no model. The tool loop owns dispatch and tracing. The
 * map is sorted throughout, so it is byte-stable for a given grant (the
 * prompt cache needs that) whatever order the grant comes in.
 */

import { TOOL_AREA_GLOSSES } from './areas';
import {
  buildDeferredToolset,
  MAP_META_SLUGS,
  splitCore,
  TOOL_CALL_SLUG,
  TOOL_HELP_SLUG,
  type DeferredToolDef,
  type ToolSearchResult,
  type ToolSource,
} from './deferred';
import { summarize, type GroupSource } from './rank';

/** The `other:` line of a one-tool area: its description's opening, capped. */
const OTHER_SUMMARY_CHARS = 70;
const HELP_DESCRIPTION_CHARS = 600;
/** How many tools one `tool_help` returns, by names or by area. */
export const TOOL_HELP_AREA_LIMIT = 15;
/** The most characters of cards one `tool_help` returns: a connector's
 *  schema can be large, and the result lands in the uncached tail. The
 *  first card always goes; the note names the ones left out. */
export const TOOL_HELP_MAX_CHARS = 40_000;
/** How many granted names a wrong name is answered with. */
const DID_YOU_MEAN_COUNT = 3;
/** How many unknown names one `tool_help` answers with a did-you-mean. */
const HELP_UNKNOWN_LIMIT = 5;

// The text the bench measured (run2.ts MAP_RULE / MAP_BLOCK), word for word.
const MAP_RULE =
  'The map tools are yours: never say you cannot do a task, and never answer a task without ' +
  'acting, before you have checked the map. A general tool (search_nodes, search_chunks, ' +
  'file_read, page_list) is not a stand-in for a specific one. When the request is about ' +
  'contacts, notes, folders, entities, the graph, images, video, speech, your own persona or ' +
  'style, Recall maps, email, events, tasks, journal, sharing, formulas, apps or places, look at ' +
  'the map first: if a listed tool does that action, use it.';

function mapBlock(map: string): string {
  return (
    '## Tool map\nYou hold the core tools directly. Every other tool you are granted is named in the ' +
    'map below, one line per area, as `area: object(verb verb) verb`. Read `page: block(update)` as ' +
    'the tool `page_block_update`, and `web: search(. pro)` as `web_search` and `web_search_pro`. ' +
    'To use a map tool, call tool_call with its full name and its arguments. If you do not know its ' +
    'arguments, call tool_help with the name (or the area) first; a call with wrong arguments ' +
    `returns the schema so you can retry.\nRule: ${MAP_RULE}\n${map}`
  );
}

const TOOL_CALL_DEF: DeferredToolDef = {
  type: 'function',
  function: {
    name: TOOL_CALL_SLUG,
    description:
      'Call any tool named in the tool map. `name` is the full tool name (e.g. "email_send"); ' +
      '`arguments` must match its input schema. Wrong arguments return the schema so you can retry.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The full tool name, e.g. "contact_create".' },
        arguments: { type: 'object', description: "The tool's arguments." },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    },
  },
};

const TOOL_HELP_DEF: DeferredToolDef = {
  type: 'function',
  function: {
    name: TOOL_HELP_SLUG,
    description:
      'Return the full description and input schema of map tools, by name or by area (e.g. area ' +
      '"contact"). Use it when you do not know a map tool\'s arguments.',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Full tool names, e.g. ["event_update"].',
        },
        area: { type: 'string', description: 'An area from the map, e.g. "page".' },
      },
      additionalProperties: false,
    },
  },
};

export type ToolHelpResult = ToolSearchResult;

export type MapToolset = {
  /** What the model is sent: core defs (core order) + tool_call + tool_help. */
  sent: DeferredToolDef[];
  /** Granted tools named in the map, not sent in full. */
  mapped: ReadonlySet<string>;
  /** Text the loop appends to the first (cached) system block: the rule and
   *  the map. Stable for a given grant. */
  systemBlock: string;
  /** `tool_help`: full descriptions and schemas by name or by area. */
  help: (query: { names?: unknown; area?: unknown }) => ToolHelpResult;
  /** `tool_search`, kept as an alias: deferred loading's ranking. */
  search: (query: string, flow?: string) => ToolSearchResult;
  /** The granted names closest to `name`, for a name that is not granted. */
  didYouMean: (name: string) => string[];
};

/** A slug's area (first word) and the rest. */
function areaOf(slug: string): [string, string] {
  const i = slug.indexOf('_');
  return i < 0 ? [slug, ''] : [slug.slice(0, i), slug.slice(i + 1)];
}

/**
 * Render the map of `slugs`. Areas with more tools first, then by name; one
 * line per area of two or more tools, with its gloss when `glossOf` gives one.
 * A one-tool area goes on the `other:` list, one line per name, with
 * `describe`'s line when it gives one (names only otherwise); so does a
 * tool the grammar cannot write: one named just like its area (`search`
 * beside `search_web`), or one with an empty word (`foo__bar`).
 */
export function renderToolMap(
  slugs: readonly string[],
  glossOf: (area: string) => string | null,
  describe: (slug: string) => string | null,
): string {
  const byArea = new Map<string, string[]>();
  const other: string[] = [];
  for (const s of [...new Set(slugs)].sort()) {
    const [area, rest] = areaOf(s);
    if (rest === '' || s.includes('__') || s.endsWith('_')) other.push(s);
    else byArea.set(area, [...(byArea.get(area) ?? []), rest]);
  }
  const areas = [...byArea.keys()].sort(
    (a, b) => byArea.get(b)!.length - byArea.get(a)!.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const lines: string[] = [];
  for (const area of areas) {
    const rests = byArea.get(area)!;
    if (rests.length === 1) {
      other.push(`${area}_${rests[0]}`);
      continue;
    }
    // rests are sorted (slugs were), so objects and their verbs are too.
    const byObject = new Map<string, string[]>();
    for (const r of rests) {
      const [object, verb] = areaOf(r);
      byObject.set(object, [...(byObject.get(object) ?? []), verb]);
    }
    const parts: string[] = [];
    for (const [object, verbs] of byObject) {
      if (verbs.length === 1) parts.push(verbs[0] ? `${object}_${verbs[0]}` : object);
      else parts.push(`${object}(${verbs.map((v) => v || '.').join(' ')})`);
    }
    const gloss = glossOf(area);
    lines.push(`${area}${gloss ? ` (${gloss})` : ''}: ${parts.join(' ')}`);
  }
  if (other.length) {
    lines.push('other:');
    for (const s of other.sort()) {
      const line = describe(s);
      lines.push(line ? `- ${s}: ${line}` : `- ${s}`);
    }
  }
  return lines.join('\n');
}

/** Edit distance, for did-you-mean. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Split a turn's full tool definitions into the sent set and the map. `defs`
 * are every tool the gate lists for the loop (buildToolsForModel), any order;
 * `groups` and `sources` as for buildDeferredToolset (the tool_search alias
 * ranks with them; `sources` also decide whose description an `other:` line
 * may carry and whether an area gets its gloss). Returns null when nothing is
 * left to map, so the caller sends the full list unchanged.
 */
export function buildMapToolset(
  defs: readonly DeferredToolDef[],
  groups: readonly GroupSource[],
  sources?: ReadonlyMap<string, ToolSource>,
): MapToolset | null {
  // A tool named like a meta tool cannot be called in this mode (the loop
  // takes the name): never offered, by the map, the tool_search alias,
  // tool_help or a did-you-mean.
  const callable = defs.filter((d) => !MAP_META_SLUGS.has(d.function.name));
  const { core, rest } = splitCore(callable);
  const deferred = buildDeferredToolset(callable, groups, sources);
  if (rest.length === 0 || !deferred) return null;
  const defBy = new Map(defs.map((d) => [d.function.name, d]));
  const sourceOf = (slug: string): ToolSource =>
    sources ? (sources.get(slug) ?? 'remote') : 'builtin';
  const mapped = rest.map((d) => d.function.name).sort();
  const mappedSet = new Set(mapped);
  // A gloss is the brain's word on its own tools: only on an area whose
  // granted tools are all builtins, so a tool someone else named into an
  // area (an OpenAPI `email_forward_all`) never reads as the brain's own.
  const glossed = new Set(mapped.map((s) => areaOf(s)[0]));
  for (const s of mapped) if (sourceOf(s) !== 'builtin') glossed.delete(areaOf(s)[0]);
  const map = renderToolMap(
    mapped,
    (area) => (glossed.has(area) ? (TOOL_AREA_GLOSSES[area] ?? null) : null),
    (slug) =>
      sourceOf(slug) === 'remote'
        ? null
        : summarize(defBy.get(slug)!.function.description, OTHER_SUMMARY_CHARS) || null,
  );
  const names = callable.map((d) => d.function.name).sort();
  const didYouMean = (name: string): string[] =>
    names
      .map((n) => [n, distance(name, n)] as const)
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, DID_YOU_MEAN_COUNT)
      .map(([n]) => n);
  const card = (slug: string) => {
    const d = defBy.get(slug)!;
    return {
      name: slug,
      description: summarize(d.function.description, HELP_DESCRIPTION_CHARS),
      input_schema: d.function.parameters,
    };
  };
  /** Cards for `slugs`, up to the count and character caps; the rest named. */
  const cards = (
    slugs: readonly string[],
  ): { tools: ReturnType<typeof card>[]; left: string[] } => {
    const tools: ReturnType<typeof card>[] = [];
    let chars = 0;
    for (const [i, s] of slugs.entries()) {
      const c = card(s);
      const size = JSON.stringify(c).length;
      if (i >= TOOL_HELP_AREA_LIMIT || (tools.length > 0 && chars + size > TOOL_HELP_MAX_CHARS)) {
        return { tools, left: slugs.slice(i) };
      }
      tools.push(c);
      chars += size;
    }
    return { tools, left: [] };
  };
  const leftNote = (left: readonly string[]) =>
    `${left.length} more not shown (too many at once): call tool_help again with their names: ` +
    `${left.join(', ')}.`;
  const help = (q: { names?: unknown; area?: unknown }): ToolHelpResult => {
    const list = typeof q.names === 'string' ? [q.names] : Array.isArray(q.names) ? q.names : [];
    const asked = [
      ...new Set(list.filter((n): n is string => typeof n === 'string').map((n) => n.trim())),
    ].filter(Boolean);
    if (asked.length > 0) {
      const known = asked.filter((n) => names.includes(n));
      const unknown = asked.filter((n) => !names.includes(n));
      const { tools, left } = cards(known);
      const notes = unknown
        .slice(0, HELP_UNKNOWN_LIMIT)
        .map((n) => `No tool named '${n}'. Did you mean: ${didYouMean(n).join(', ')}?`);
      if (unknown.length > HELP_UNKNOWN_LIMIT) {
        notes.push(
          `${unknown.length - HELP_UNKNOWN_LIMIT} more names are not tools either: check them in the tool map.`,
        );
      }
      if (left.length) notes.push(leftNote(left));
      if (tools.length) notes.push('Call one with tool_call.');
      return { tools, note: notes.join(' ') };
    }
    const area = typeof q.area === 'string' ? q.area.trim().replace(/_+$/, '') : '';
    if (!area) {
      return {
        tools: [],
        note: 'tool_help needs `names` (full tool names) or `area` (an area from the tool map).',
      };
    }
    const inArea = mapped.filter((s) => areaOf(s)[0] === area || s.startsWith(`${area}_`));
    if (inArea.length === 0) {
      return {
        tools: [],
        note: `No area '${area}' in the tool map. Pick an area from the map, or pass full tool names as \`names\`.`,
      };
    }
    const { tools, left } = cards(inArea);
    return {
      tools,
      note: left.length
        ? `Showing ${tools.length} of ${inArea.length} tools in '${area}'. ${leftNote(left)}`
        : 'Call one with tool_call.',
    };
  };
  return {
    sent: [...core, TOOL_CALL_DEF, TOOL_HELP_DEF],
    mapped: mappedSet,
    systemBlock: mapBlock(map),
    help,
    search: deferred.search,
    didYouMean,
  };
}
