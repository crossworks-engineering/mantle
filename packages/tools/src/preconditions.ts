/**
 * Declarative per-tool preconditions, checked centrally before a builtin's
 * handler runs (see dispatch.ts).
 *
 * The biggest wrong-usage class after schema violations is referential: an
 * operation aimed at an id that doesn't exist, or that names a node of the
 * WRONG TYPE (a note id passed to a page tool). Handlers catch the first
 * case with scattered, inconsistently-worded checks and rarely catch the
 * second at all — the query just misses and the error says "not found",
 * hiding the real mistake. Declaring the requirement on the tool def gives
 * every flagged tool the same three teaching errors:
 *
 *   · malformed id  → "'page_id' must be a node id (UUID), got 'Overview'
 *                      — pass the id, not the title (find it with …)"
 *   · missing node  → the standard notFound() teaching error
 *   · wrong type    → "id … is a note, not a page — pass a page id …"
 *
 * One indexed PK lookup per flagged param — sub-ms; handlers keep their own
 * checks as backstops (the precondition read isn't transactional with the
 * handler's work).
 *
 * The second kind, `markdown_refs`, covers ids that ride INSIDE a body rather
 * than in a param of their own: `![alt](media:<file-id>)` and friends. Those
 * failed silently until now — a page stored with a dangling `media:` id renders
 * a blank where the picture should be, and nothing tells the model. A real
 * instance: an image was generated, its id never reached the next turn, and the
 * model rebuilt a UUID from the 8-char display prefix the corpus map shows
 * (`file#2153d1f2`). `page_create` accepted it. The error below therefore names
 * that exact mistake, because it is the one a model is most likely to make.
 */

import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { markdownRefs, type MarkdownRef } from '@mantle/content/markdown-refs';
import { mermaidLabelProblems } from '@mantle/content/mermaid-lint';
import { notFound } from './errors';
import type { ToolHandlerResult, ToolPrecondition } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Injectable for tests: resolve a node's type by (ownerId, id); null when
 *  the node doesn't exist (or isn't the owner's). */
export type NodeTypeLookup = (ownerId: string, id: string) => Promise<string | null>;

async function defaultNodeTypeLookup(ownerId: string, id: string): Promise<string | null> {
  const [row] = await db
    .select({ type: nodes.type })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId)))
    .limit(1);
  return row?.type ?? null;
}

/** Where to send the model to find a real id, per reference scheme. */
const REF_LOOKUP: Record<MarkdownRef['scheme'], string> = {
  media: 'file_list / search_nodes',
  page: 'page_list / search_nodes',
  mention: 'search_nodes',
  draw: 'draw_list / search_nodes',
};

/** The href form as written, for quoting back in the error. */
function refHref(ref: MarkdownRef): string {
  return ref.scheme === 'mention' ? `mention:node:${ref.id}` : `${ref.scheme}:${ref.id}`;
}

/** Collect the markdown a `markdown_refs` precondition points at — either a
 *  plain string param, or the `itemKey` of every object in an array param. */
function markdownSources(
  input: Record<string, unknown>,
  param: string,
  itemKey?: string,
): string[] {
  const raw = input[param];
  if (typeof raw === 'string') return raw ? [raw] : [];
  if (itemKey && Array.isArray(raw)) {
    return raw
      .map((item) =>
        item && typeof item === 'object' ? (item as Record<string, unknown>)[itemKey] : undefined,
      )
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  return [];
}

/** Check every app-native reference in a body. One combined error for the whole
 *  body, not one per bad id — a page with three dangling images should cost one
 *  retry, not three. */
async function checkMarkdownRefs(
  input: Record<string, unknown>,
  param: string,
  itemKey: string | undefined,
  ownerId: string,
  lookup: NodeTypeLookup,
): Promise<ToolHandlerResult | null> {
  const refs = markdownSources(input, param, itemKey).flatMap((md) => markdownRefs(md));
  if (refs.length === 0) return null;

  const problems: string[] = [];
  const lookups: string[] = [];
  const resolved = await Promise.all(
    refs.map(async (ref) => ({
      ref,
      type: UUID_RE.test(ref.id) ? await lookup(ownerId, ref.id) : null,
    })),
  );
  for (const { ref, type } of resolved) {
    if (type === null) {
      problems.push(`\`${refHref(ref)}\` (no such node)`);
      lookups.push(REF_LOOKUP[ref.scheme]);
    } else if (ref.nodeType && type !== ref.nodeType) {
      problems.push(`\`${refHref(ref)}\` (that id is a ${type}, not a ${ref.nodeType})`);
      lookups.push(REF_LOOKUP[ref.scheme]);
    }
  }
  if (problems.length === 0) return null;

  const where = itemKey ? `'${param}[].${itemKey}'` : `'${param}'`;
  return {
    ok: false,
    error:
      `${where} references ${problems.length} id${problems.length === 1 ? '' : 's'} that ` +
      `${problems.length === 1 ? 'does' : 'do'} not exist: ${problems.join(', ')}. ` +
      'Nothing was written. A reference id must be COPIED WHOLE from a tool result — ' +
      'never reconstructed from a shortened display form like `file#2153d1f2`, which is a ' +
      'prefix, not an id. Look the real id up with ' +
      `${[...new Set(lookups)].join(' / ')} and re-issue with the full UUID.`,
  };
}

/** Check every ```mermaid fence in a body for the one mistake that ships a
 *  broken diagram silently: an unquoted node label containing parentheses. One
 *  combined error per body, same as the ref check. */
function checkMermaidLabels(
  input: Record<string, unknown>,
  param: string,
  itemKey: string | undefined,
): ToolHandlerResult | null {
  const problems = markdownSources(input, param, itemKey).flatMap((md) => mermaidLabelProblems(md));
  if (problems.length === 0) return null;

  const quoted = problems
    .map((p) => `\`${p.node}[${p.label.length > 60 ? `${p.label.slice(0, 60)}…` : p.label}]\``)
    .join(', ');
  const where = itemKey ? `'${param}[].${itemKey}'` : `'${param}'`;
  return {
    ok: false,
    error:
      `${where} has ${problems.length} Mermaid node label${problems.length === 1 ? '' : 's'} ` +
      `containing parentheses but not wrapped in double quotes: ${quoted}. ` +
      'Nothing was written. Mermaid reads the `(` as the start of a round-node shape, so the ' +
      'WHOLE diagram fails to parse and renders as an error strip. Wrap any label containing ' +
      '`(`, `)`, `{`, `}`, `[` or `]` in double quotes — `R["deputy approver (backup)"]`, not ' +
      '`R[deputy approver (backup)]` — and re-issue.',
  };
}

/**
 * Check a tool's declared preconditions against the (already coerced) input.
 * Returns a teaching-error result to send back to the model, or null when
 * all preconditions hold and the handler may run.
 */
export async function checkToolPreconditions(
  preconditions: readonly ToolPrecondition[],
  input: Record<string, unknown>,
  ownerId: string,
  lookup: NodeTypeLookup = defaultNodeTypeLookup,
): Promise<ToolHandlerResult | null> {
  for (const pre of preconditions) {
    if (pre.kind === 'markdown_refs') {
      const failure = await checkMarkdownRefs(input, pre.param, pre.itemKey, ownerId, lookup);
      if (failure) return failure;
      continue;
    }
    if (pre.kind === 'mermaid_labels') {
      const failure = checkMermaidLabels(input, pre.param, pre.itemKey);
      if (failure) return failure;
      continue;
    }
    const raw = input[pre.param];
    if (raw === undefined || raw === null || raw === '') {
      // Presence is the schema's job (required/validate-args) — a missing
      // optional param is not a precondition failure.
      continue;
    }
    const id = typeof raw === 'string' ? raw.trim() : '';
    const kindName = pre.nodeType ?? 'node';
    if (!UUID_RE.test(id)) {
      return {
        ok: false,
        error:
          `'${pre.param}' must be a ${kindName} id (UUID), got '${String(raw).slice(0, 60)}' — ` +
          `pass the id, not a title or name. Find it with ${pre.lookup}.`,
      };
    }
    const actualType = await lookup(ownerId, id);
    if (actualType === null) {
      return notFound(kindName, id, pre.lookup);
    }
    if (pre.nodeType && actualType !== pre.nodeType) {
      return {
        ok: false,
        error:
          `'${pre.param}' ${id} is a ${actualType}, not a ${pre.nodeType} — ` +
          `pass a ${pre.nodeType} id (find it with ${pre.lookup}).`,
      };
    }
  }
  return null;
}
