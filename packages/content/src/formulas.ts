/**
 * Formulas surface. A formula is a `nodes` row with type='formula':
 *
 *   nodes.title       display name (from spec.name, else spec.id)
 *   nodes.data.spec   the validated FormulaSpec (see ./formula-spec.ts)
 *   nodes.tags        freeform tags
 *
 * All under the `formulas` ltree root, lazy-created on first write. No sidecar
 * table: a spec is a few kilobytes of JSON and lives entirely in nodes.data.
 *
 * `formula` is in the extractor's DEFAULT_EXTRACT_TYPES, so summary + 768-dim
 * embedding land automatically on the next pg_notify('node_ingested'); the
 * extractor renders the body through `formulaToText`. The generated
 * `nodes.search_tsv` already covers the raw spec JSON, so FTS works without a
 * persisted copy of the rendered text — which is why one is NOT stored. A
 * second representation of the same spec could drift from it, and for a
 * calculation transcribed out of a safety standard, two disagreeing copies is
 * a worse failure than a slightly noisier FTS vector.
 *
 * Nothing here evaluates anything — evaluation is pure and lives in
 * ./formula-eval.ts. This module only persists and retrieves.
 */
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import {
  db,
  nodes,
  changedFields,
  markContentChanged,
  type Node,
  withDeadlockRetry,
  withNodeDeleteHeads,
  withNodeInsertHeads,
  nodeReadByWorkspace,
} from '@mantle/db';
import { parseFormulaSpec, type FormulaSpec } from '@mantle/content-core/formula-spec';
import { asKindRootRepair } from './kind-root';
import { defineDomainError, isUuid } from '@mantle/std';
import { dedupeTags } from './tags';

export const FORMULA_ROOT_LABEL = 'formulas';

export type FormulaRow = {
  id: string;
  title: string;
  spec: FormulaSpec;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowOf(n: Node): FormulaRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const summary = typeof d.summary === 'string' && d.summary.trim() ? d.summary.trim() : null;
  return {
    id: n.id,
    title: n.title,
    // Stored specs were validated on the way in, so this is a cast rather than
    // a re-parse; `readFormulaSpec` re-validates when a caller needs certainty.
    spec: d.spec as FormulaSpec,
    tags: n.tags ?? [],
    summary,
    createdAt: (n.createdAt as unknown as Date)?.toISOString?.() ?? String(n.createdAt),
    updatedAt: (n.updatedAt as unknown as Date)?.toISOString?.() ?? String(n.updatedAt),
  };
}

/** The kind's root folder, made as system(repair:kind-root) (kind-root.ts). */
async function ensureRoot(ownerId: string): Promise<void> {
  await asKindRootRepair(() => ensureRootNow(ownerId));
}

async function ensureRootNow(ownerId: string): Promise<void> {
  await withDeadlockRetry(() =>
    withNodeInsertHeads(ownerId, [{ type: 'branch', path: FORMULA_ROOT_LABEL }], (tx) =>
      tx
        .insert(nodes)
        .values({
          ownerId,
          type: 'branch',
          title: 'Formulas',
          slug: FORMULA_ROOT_LABEL,
          path: FORMULA_ROOT_LABEL,
          data: {
            description:
              'Calculation models taken from published standards — equations, branches, lookup tables and rating criteria. Indexed and embedded so they can be found and cited.',
          },
        })
        .onConflictDoNothing({
          target: [nodes.ownerId, nodes.path],
          where: sql`${nodes.type} = 'branch'`,
        }),
    ),
  );
}

/** Validation failed on the way in. Carries every problem, not just the first. */
export class FormulaSpecError extends Error {
  constructor(readonly errors: string[]) {
    super(`invalid formula spec: ${errors.join('; ')}`);
    this.name = 'FormulaSpecError';
  }
}

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): every
// problem at once, so the editor shows them together.
defineDomainError(FormulaSpecError, {
  reason: 'the formula spec the caller sent has problems; the list says which',
  status: 400,
  body: (e) => ({ error: e.message, errors: e.errors }),
});

/** No formula of that id for this owner (readFormulaSpec). */
export class FormulaNotFoundError extends Error {
  constructor(id: string) {
    super(`formula '${id}' not found`);
    this.name = 'FormulaNotFoundError';
  }
}

// What the evaluate route answered by hand: 404 and the message.
defineDomainError(FormulaNotFoundError, {
  reason: 'the formula the caller named is not there',
  status: 404,
});

/**
 * Structural check rather than `instanceof`, because callers live in other
 * packages. If the bundler ever resolves two copies of this module, an
 * `instanceof` test fails silently and the caller reports a generic message
 * instead of the list of spec problems — which is the whole value of the error.
 */
export function isFormulaSpecError(err: unknown): err is FormulaSpecError {
  return (
    err instanceof Error &&
    err.name === 'FormulaSpecError' &&
    Array.isArray((err as FormulaSpecError).errors)
  );
}

function validate(input: unknown): FormulaSpec {
  const parsed = parseFormulaSpec(input);
  if (!parsed.ok) throw new FormulaSpecError(parsed.errors);
  return parsed.spec;
}

export type CreateFormulaInput = {
  spec: unknown;
  title?: string;
  tags?: string[];
};

export async function createFormula(
  ownerId: string,
  input: CreateFormulaInput,
): Promise<FormulaRow> {
  const spec = validate(input.spec);
  await ensureRoot(ownerId);
  const title = (input.title?.trim() || spec.name || spec.id).slice(0, 200);
  const [row] = await withDeadlockRetry(() =>
    withNodeInsertHeads(ownerId, [{ type: 'formula', path: FORMULA_ROOT_LABEL }], (tx) =>
      tx
        .insert(nodes)
        .values({
          ownerId,
          type: 'formula',
          title,
          path: FORMULA_ROOT_LABEL,
          data: { spec },
          tags: dedupeTags(input.tags ?? []),
        })
        .returning(),
    ),
  );
  if (!row) throw new Error('createFormula: insert returned no row');
  return rowOf(row);
}

type ListFormulasOpts = {
  query?: string;
  standard?: string;
  tag?: string;
  /** Only the items this workspace reads (`?ws=`, a checked id). */
  ws?: string;
};

function formulaConds(ownerId: string, opts: ListFormulasOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'formula')];
  if (opts.ws) conds.push(nodeReadByWorkspace(opts.ws));
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->'spec'->>'id' ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.standard) {
    conds.push(sql`${nodes.data}->'spec'->'source'->>'standard' = ${opts.standard}`);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listFormulas(
  ownerId: string,
  opts: ListFormulasOpts & { limit?: number; offset?: number } = {},
): Promise<FormulaRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...formulaConds(ownerId, opts)))
    .orderBy(nodes.title)
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map(rowOf);
}

export async function countFormulas(ownerId: string, opts: ListFormulasOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...formulaConds(ownerId, opts)));
  return row?.n ?? 0;
}

/**
 * Every `spec.id` the owner already holds, uncapped.
 *
 * The seeder's "already present" check used `listFormulas` — whose default
 * LIMIT is 500 — so on a brain past that, presence detection silently ran on a
 * page of the collection and re-seeding could duplicate. Presence is a
 * question about ALL formulas or it is not a presence check.
 */
export async function listFormulaSpecIds(ownerId: string): Promise<Set<string>> {
  const rows = await db
    .select({ specId: sql<string | null>`${nodes.data}->'spec'->>'id'` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'formula')));
  return new Set(
    rows.map((r) => r.specId).filter((s): s is string => typeof s === 'string' && s !== ''),
  );
}

/**
 * The distinct source standards across ALL of an owner's formulas.
 *
 * Deliberately unfiltered: this populates the standard filter itself, and a
 * dropdown built from the current (filtered, paged) result set would drop the
 * option you are standing on the moment you select it.
 */
export async function listFormulaStandards(ownerId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ standard: sql<string>`${nodes.data}->'spec'->'source'->>'standard'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'formula'),
        sql`${nodes.data}->'spec'->'source'->>'standard' is not null`,
      ),
    );
  return rows
    .map((r) => r.standard)
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .sort((a, b) => a.localeCompare(b));
}

export async function getFormula(ownerId: string, id: string): Promise<FormulaRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'formula')))
    .limit(1);
  return row ? rowOf(row) : null;
}

/**
 * Fetch a spec and re-validate it. Use before evaluating: a spec written by an
 * older version of the schema, or edited straight in the DB, should fail here
 * with a list of problems rather than half-evaluate.
 */
export async function readFormulaSpec(ownerId: string, id: string): Promise<FormulaSpec> {
  // An id that is not a uuid names no formula: 404, not the database's cast
  // error (A10 part 2 fix round 1, M2).
  if (!isUuid(id)) throw new FormulaNotFoundError(id);
  const row = await getFormula(ownerId, id);
  if (!row) throw new FormulaNotFoundError(id);
  return validate(row.spec);
}

export type UpdateFormulaInput = {
  spec?: unknown;
  title?: string;
  tags?: string[];
};

export async function updateFormula(
  ownerId: string,
  id: string,
  input: UpdateFormulaInput,
): Promise<FormulaRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'formula')))
    .limit(1);
  if (!node) return null;

  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const data = { ...oldData };
  const specChanged = input.spec !== undefined;
  if (specChanged) data.spec = validate(input.spec);

  const nextTitle = input.title?.trim()
    ? input.title.trim().slice(0, 200)
    : specChanged
      ? ((data.spec as FormulaSpec).name ?? (data.spec as FormulaSpec).id).slice(0, 200)
      : undefined;

  // What the index must redo (the kind registry's `indexed`), compared by
  // value: a changed spec re-extracts (the reset drops the summary with the
  // vector, so formula_get never serves a summary of the previous spec, and
  // no `half_indexed` row is made); a new title re-embeds.
  const changed = changedFields({
    title: [node.title, nextTitle ?? node.title],
    spec: [oldData.spec, data.spec],
  });
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodes)
      .set({
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
        data,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) return row;
    return (await markContentChanged(tx, { id, type: 'formula' }, changed)) ?? row;
  });
  if (!updated) throw new Error('updateFormula: update returned no row');
  return rowOf(updated);
}

export async function deleteFormula(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'formula')))
    .limit(1);
  if (!row) return false;
  await withDeadlockRetry(() =>
    withNodeDeleteHeads([id], (tx) => tx.delete(nodes).where(eq(nodes.id, id))),
  );
  return true;
}
