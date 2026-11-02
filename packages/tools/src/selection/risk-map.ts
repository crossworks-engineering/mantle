/**
 * The risk map: the tool map (map.ts) split by risk class, for the owner MCP
 * surface (@mantle/mcp-core map-surface.ts). An MCP client has no system
 * prompt to carry a map, and the protocol lets it ask before a call by the
 * tool's hints, so instead of one `tool_call` the map is reached through
 * four call tools, one per class (tool-policy.ts RiskClass): `tool_read`,
 * `tool_write`, `tool_delete`, `tool_send`. Each call tool's description
 * holds its own class's part of the map, so the class is chosen by where a
 * name is listed, and a client can let reads run unasked. Only tool_read
 * makes that promise (four audits checked it tool by tool): the line
 * between a write and a send is drawn per tool, so the other three ask.
 *
 * A call through the wrong call tool is refused with the right one named;
 * the gate still decides every call that runs (the class decides nothing
 * about access).
 *
 * Bench of 2026-11-02 (plan 876cbbeb section 14; 101 tool-choice cases plus
 * 18 risky ones, four models): right first tool the same as one `tool_call`,
 * and 223 of 225 first call-tool uses in the right class; both misses (a
 * web read through tool_read) recovered after one refusal.
 *
 * Pure: no database, no model. The map is sorted throughout, so each
 * description is byte-stable for a given set of tools.
 */

import type { RiskClass } from '../tool-policy';
import { TOOL_AREA_GLOSSES } from './areas';
import { TOOL_HELP_SLUG, type DeferredToolDef, type ToolSource } from './deferred';
import { mapLookups, renderToolMap, type MapToolset } from './map';
import { summarize } from './rank';

/** The call tool of each class. */
export const RISK_CALL_SLUGS: Readonly<Record<RiskClass, string>> = Object.freeze({
  read: 'tool_read',
  write: 'tool_write',
  delete: 'tool_delete',
  send: 'tool_send',
});

const CLASSES: readonly RiskClass[] = ['read', 'write', 'delete', 'send'];
const OTHER_SUMMARY_CHARS = 70;

/** One tool of the map: its definition, class and who wrote it. */
export type RiskMapTool = DeferredToolDef & { cls: RiskClass; source: ToolSource };

/** What a class's call tool does, the opening of its description. */
const CLASS_LINES: Readonly<Record<RiskClass, string>> = {
  read:
    'Run a READ tool from the map below: it changes nothing, and nothing leaves the brain but a ' +
    "linked brain read's query to that brain (the `peer` tools) and what the brain's own model " +
    'providers are given.',
  write:
    'Run a WRITE tool from the map below: it creates, changes or overwrites data inside the ' +
    'brain, messages people in the brain, or hands work to an agent or a renderer that may use ' +
    'its own tools.',
  delete: 'Run a DELETE tool from the map below: it removes data from the brain.',
  send:
    'Run a SEND tool from the map below: it reaches outside the brain (mail, Telegram, a ' +
    "linked brain's write, the open web, a public link, an outside API or connector, a shell " +
    'or sandbox with network, a held or queued call that runs unattended).',
};

const MAP_HOW =
  '`name` is the full tool name and `arguments` its arguments; call tool_help with the name ' +
  'or the area when you do not know them (a call with wrong arguments returns the schema). ' +
  'Read a map line `page: block(update)` as the tool `page_block_update`, and ' +
  '`web: search(. pro)` as `web_search` and `web_search_pro`.';

// Said once, on tool_read (the one every client reads first): the map's
// rule from the 2026-10-31 bench, cut to what an outside client needs.
const MAP_RULE =
  'The map tools are yours: check the map before you say you cannot do a task. A general ' +
  'tool (search, search_chunks, file_read) is not a stand-in for a specific one.';

export type RiskMap = {
  /** tool_help, then one call tool per class that has a tool, in class order. */
  calls: DeferredToolDef[];
  /** `tool_help` over every tool (direct and mapped). */
  help: MapToolset['help'];
  /** Whether `name` may be called through `via`: a refusal names the fix. */
  route: (via: RiskClass, name: string) => { ok: true } | { ok: false; error: string };
};

/** A class's call tool. */
function callDef(cls: RiskClass, map: string): DeferredToolDef {
  const others = CLASSES.filter((c) => c !== cls)
    .map((c) => `${c} with ${RISK_CALL_SLUGS[c]}`)
    .join(', ');
  return {
    type: 'function',
    function: {
      name: RISK_CALL_SLUGS[cls],
      description:
        `${CLASS_LINES[cls]} ${MAP_HOW} Call a ${others}.` +
        (cls === 'read' ? ` ${MAP_RULE}` : '') +
        `\n${map}`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The full tool name, e.g. "contact_get".' },
          arguments: { type: 'object', description: "The tool's arguments." },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  };
}

const HELP_DEF: DeferredToolDef = {
  type: 'function',
  function: {
    name: TOOL_HELP_SLUG,
    description:
      'Return the full description, input schema and call tool of map tools, by name or by area ' +
      '(e.g. area "contact"). Use it when you do not know a map tool\'s arguments.',
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

/** An area's first word, as map.ts reads it. */
function areaOf(slug: string): string {
  const i = slug.indexOf('_');
  return i < 0 ? slug : slug.slice(0, i);
}

/**
 * Build the risk map of `mapped` (the tools reached only through a call
 * tool) and `direct` (the tools a client is sent in full; a read call tool
 * takes them too, so a call by either road works). Returns null when
 * nothing is mapped, so the caller lists every tool in full.
 */
export function buildRiskMap(
  mapped: readonly RiskMapTool[],
  direct: readonly RiskMapTool[] = [],
): RiskMap | null {
  if (mapped.length === 0) return null;
  const all = [...direct, ...mapped];
  const clsOf = new Map(all.map((t) => [t.function.name, t.cls]));
  const sourceOf = new Map(all.map((t) => [t.function.name, t.source]));
  // A gloss only on an area whose mapped tools are all builtins (map.ts).
  const glossed = new Set(mapped.map((t) => areaOf(t.function.name)));
  for (const t of mapped) if (t.source !== 'builtin') glossed.delete(areaOf(t.function.name));
  const descriptionOf = new Map(all.map((t) => [t.function.name, t.function.description]));
  const mappedNames = mapped.map((t) => t.function.name).sort();
  const { help, didYouMean } = mapLookups(
    all,
    mappedNames,
    (slug) => RISK_CALL_SLUGS[clsOf.get(slug)!],
  );
  const calls: DeferredToolDef[] = [HELP_DEF];
  for (const cls of CLASSES) {
    const names = mappedNames.filter((n) => clsOf.get(n) === cls);
    if (names.length === 0) continue;
    const map = renderToolMap(
      names,
      (area) => (glossed.has(area) ? (TOOL_AREA_GLOSSES[area] ?? null) : null),
      (slug) =>
        sourceOf.get(slug) === 'remote'
          ? null
          : summarize(descriptionOf.get(slug)!, OTHER_SUMMARY_CHARS) || null,
    );
    calls.push(callDef(cls, map));
  }
  const route = (via: RiskClass, name: string) => {
    const cls = clsOf.get(name);
    if (!cls) {
      const near = didYouMean(name).map((n) => `${n} (${RISK_CALL_SLUGS[clsOf.get(n)!]})`);
      return {
        ok: false as const,
        error: `No tool named '${name}'. Did you mean: ${near.join(', ')}? Check the map in the call tools' descriptions.`,
      };
    }
    if (cls === via) return { ok: true as const };
    return {
      ok: false as const,
      error: `'${name}' is a ${cls} tool, not ${via}: call it with ${RISK_CALL_SLUGS[cls]} (same name and arguments).`,
    };
  };
  return { calls, help, route };
}
