/**
 * Description lint — enforces the mechanical subset of the description
 * style guide in ../CLAUDE.md over every registered builtin, the way
 * manifest.test.ts enforces slug integrity for the system manifest.
 *
 * What lives here vs the guide: judgment calls (first-sentence quality,
 * boundary phrasing) stay prose in CLAUDE.md; everything a regex can
 * check (presence, cross-reference rot, length budget, schema
 * duplication, precondition coverage) fails loudly here so it can't
 * drift silently.
 *
 * Scope: builtin defs registered in this package (`listBuiltins()`).
 * App-registered builtins that live elsewhere (e.g. @mantle/heartbeats)
 * would need this package to depend on theirs — they're governed by the
 * same guide but linted by eye for now.
 */

import { describe, expect, it } from 'vitest';
import { listBuiltins } from './registry';
import type { BuiltinToolDef } from './types';

const TOOLS = listBuiltins();
const SLUGS = new Set(TOOLS.map((t) => t.slug));

/**
 * Descriptions allowed past the ~120-word budget. Additions require a
 * justification comment — the budget exists because every description
 * ships in the system prompt of every granted agent on every turn.
 */
const SANCTIONED_ESSAYS = new Set<string>([
  'page_block_update', // markdown structural-prefix trap (heading/list markers)
  'page_split', // multi-step draft ritual with irreversible publish
  'page_blocks_apply', // batch semantics + the strategy ladder need spelling out
  'search_nodes', // the retrieval entry point — carries the whole tool-ladder map
  'search_chunks', // read_section/file_read ladder + spill semantics
  'page_from_file', // boundary vs page_create + conversion caveats
]);

/**
 * Backticked underscore-tokens that look like tool slugs but aren't.
 * Grow deliberately (named param/field/config terms) — never loosen the
 * regex instead, that's how rename rot gets back in.
 */
const NOT_A_TOOL_SLUG = new Set<string>([
  'internal_date', // email_list result field (Gmail internalDate)
  'mentioned_in', // page_mention result field
  'draft_doc', // pages draft-state field on page rows
  'next_ordinal', // read_section paging cursor field
  'total_matches', // table_query result-meta field
  'next_offset', // table_query / rows-list paging cursor field
]);

/**
 * Node-id params exempt from the precondition-coverage check. Every entry
 * needs a reason — "handler checks it" is not one (preconditions exist to
 * make the teaching error uniform and central).
 */
const PRECONDITION_EXEMPT = new Set<string>([
  // email_get.id deliberately accepts EITHER the emails-row id OR the node id
  // — a node_exists check would reject legitimate row ids.
  'email_get.id',
  // peer_node_get.nodeId names a node on a REMOTE peer — a local node_exists
  // check would reject every valid id.
  'peer_node_get.nodeId',
]);

/** Walk every {path, schema} pair under `properties` (nested objects and
 *  array items included) — every one of these renders to the model. */
function walkParams(
  schema: Record<string, unknown> | undefined,
  base: string,
  out: Array<{ path: string; schema: Record<string, unknown> }>,
): void {
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return;
  for (const [key, prop] of Object.entries(props)) {
    const path = base ? `${base}.${key}` : key;
    out.push({ path, schema: prop });
    walkParams(prop, path, out);
    const items = prop.items as Record<string, unknown> | undefined;
    if (items) walkParams(items, `${path}[]`, out);
  }
}

function paramsOf(def: BuiltinToolDef): Array<{ path: string; schema: Record<string, unknown> }> {
  const out: Array<{ path: string; schema: Record<string, unknown> }> = [];
  walkParams(def.inputSchema, '', out);
  return out;
}

const WORDS = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Lowercase with at least one underscore — the shape of our tool slugs. */
const SLUG_SHAPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function backtickedTokens(text: string): string[] {
  return Array.from(text.matchAll(/`([^`]+)`/g), (m) => m[1] ?? '');
}

describe('description lint', () => {
  it('every tool and every param has a non-empty description', () => {
    const missing: string[] = [];
    for (const def of TOOLS) {
      if (!def.description?.trim()) missing.push(def.slug);
      for (const p of paramsOf(def)) {
        const d = p.schema.description;
        if (typeof d !== 'string' || !d.trim()) missing.push(`${def.slug} → ${p.path}`);
      }
    }
    expect(missing, `missing descriptions:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('backticked slug-shaped cross-references resolve to registered tools', () => {
    const stale: string[] = [];
    for (const def of TOOLS) {
      const params = paramsOf(def);
      // Param names at any depth are legitimate backtick targets too.
      const ownParams = new Set(params.map((p) => p.path.replace(/\[\]$/, '').split('.').pop()!));
      const texts = [def.description, ...params.map((p) => String(p.schema.description ?? ''))];
      for (const text of texts) {
        for (const token of backtickedTokens(text)) {
          if (!SLUG_SHAPE.test(token)) continue;
          if (SLUGS.has(token)) continue;
          if (ownParams.has(token)) continue;
          if (NOT_A_TOOL_SLUG.has(token)) continue;
          stale.push(`${def.slug}: \`${token}\``);
        }
      }
    }
    expect(
      [...new Set(stale)],
      `unresolved slug-shaped references (stale tool name, or add to NOT_A_TOOL_SLUG with a reason):\n  ${[...new Set(stale)].join('\n  ')}`,
    ).toEqual([]);
  });

  it('descriptions stay within the ~120-word budget (or are sanctioned essays)', () => {
    const over: string[] = [];
    for (const def of TOOLS) {
      const n = WORDS(def.description ?? '');
      if (n > 120 && !SANCTIONED_ESSAYS.has(def.slug)) over.push(`${def.slug} (${n} words)`);
    }
    expect(
      over,
      `over budget — tighten the prose or (for a genuine footgun) add to SANCTIONED_ESSAYS with a justification:\n  ${over.join('\n  ')}`,
    ).toEqual([]);
  });

  it('sanctioned-essay allowlist carries no dead weight', () => {
    const stale = [...SANCTIONED_ESSAYS].filter((slug) => {
      const def = TOOLS.find((t) => t.slug === slug);
      return !def || WORDS(def.description) <= 120;
    });
    expect(
      stale,
      `no longer over budget (or gone) — remove from SANCTIONED_ESSAYS: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('enum params do not restate their options in prose', () => {
    const dupes: string[] = [];
    for (const def of TOOLS) {
      for (const p of paramsOf(def)) {
        if (!Array.isArray(p.schema.enum)) continue;
        const d = String(p.schema.description ?? '');
        if (/must be one of|one of:|∈/i.test(d)) dupes.push(`${def.slug} → ${p.path}`);
      }
    }
    expect(
      dupes,
      `enum options restated in prose (the enum renders to the model already; prose copies drift):\n  ${dupes.join('\n  ')}`,
    ).toEqual([]);
  });

  it('param prose does not restate schema default/maximum numbers', () => {
    const dupes: string[] = [];
    for (const def of TOOLS) {
      for (const p of paramsOf(def)) {
        const d = String(p.schema.description ?? '');
        if (p.schema.default !== undefined && /\bdefaults? (to )?\d/i.test(d))
          dupes.push(`${def.slug} → ${p.path} (default)`);
        if (p.schema.maximum !== undefined && /\b(cap|max\w*)\s+\d/i.test(d))
          dupes.push(`${def.slug} → ${p.path} (maximum)`);
      }
    }
    expect(
      dupes,
      `numeric bounds restated in prose (the schema keywords render to the model already; prose copies drift):\n  ${dupes.join('\n  ')}`,
    ).toEqual([]);
  });

  it('cross-reference allowlist carries no dead weight', () => {
    const allText = TOOLS.flatMap((def) => [
      def.description,
      ...paramsOf(def).map((p) => String(p.schema.description ?? '')),
    ]).join('\n');
    const stale = [...NOT_A_TOOL_SLUG].filter((t) => !allText.includes(`\`${t}\``));
    expect(
      stale,
      `no longer referenced anywhere — remove from NOT_A_TOOL_SLUG: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('node-id params are covered by a precondition', () => {
    const NODE_ID_PARAM =
      /^(page|table|note|node|journal|task|event|file|folder|contact|app|email)(_id|Id)$/;
    const DOMAIN_PREFIX = /^(page|table|note|journal|task|event|file|folder|contact|app|email)_/;
    const uncovered: string[] = [];
    for (const def of TOOLS) {
      const declared = new Set((def.preconditions ?? []).map((p) => p.param));
      const props = (def.inputSchema.properties ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(props)) {
        const isNodeId =
          NODE_ID_PARAM.test(name) || (name === 'id' && DOMAIN_PREFIX.test(def.slug));
        if (!isNodeId) continue;
        if (declared.has(name)) continue;
        if (PRECONDITION_EXEMPT.has(`${def.slug}.${name}`)) continue;
        uncovered.push(`${def.slug}.${name}`);
      }
    }
    expect(
      uncovered,
      `node-id params without a precondition — add { kind: 'node_exists', param, nodeType, lookup } to the def (or PRECONDITION_EXEMPT with a reason):\n  ${uncovered.join('\n  ')}`,
    ).toEqual([]);
  });
});
