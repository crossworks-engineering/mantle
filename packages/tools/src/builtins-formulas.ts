/**
 * Formula builtins — calculation models taken from published standards
 * (equations, branches, keyed lookup tables, rating criteria). See
 * docs/formulas.md for the storage + evaluation model.
 *
 * Why agents get these: the bottleneck with engineering formulas is
 * transcription. A standard arrives as a PDF or a screenshot; someone has to
 * turn it into something computable without quietly dropping a term. An agent
 * that can author a spec, evaluate it, and read back the trace closes that loop
 * — and `formula_evaluate` returning its derivation means the number can be
 * checked rather than trusted.
 *
 * `formula_delete` is left OFF the auto-grant (destructive).
 */

import {
  checkLookupCoverage,
  countFormulas,
  createFormula,
  deleteFormula,
  evaluateSpec,
  getFormula,
  listFormulas,
  nodeUrl,
  readFormulaSpec,
  updateFormula,
  type FormulaRow,
  type FormulaValue,
} from '@mantle/content';
import type { BuiltinToolDef, ToolPrecondition } from './types';
import { str } from './coerce';
import { notFound } from './errors';

const FORMULA_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'formula', lookup: 'formula_list / search_nodes' },
];

function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function tagList(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((t): t is string => typeof t === 'string') : [];
}

/** Light projection for lists — enough to choose one without loading the spec. */
function compact(n: FormulaRow) {
  const source = n.spec?.source;
  return {
    id: n.id,
    url: nodeUrl(n.id),
    title: n.title,
    spec_id: n.spec?.id,
    standard: source?.standard ?? null,
    tags: n.tags,
    summary: n.summary,
    updated_at: n.updatedAt,
  };
}

/** The evaluable targets, so an agent never has to guess an id. */
function targetsOf(n: FormulaRow) {
  const spec = n.spec;
  return [
    ...(spec?.expressions ?? []).map((e) => ({
      id: e.id,
      kind: 'expression' as const,
      equation: e.equation ?? null,
      produces: e.resultSymbol ?? null,
      unit: e.unit ?? null,
    })),
    ...(spec?.piecewise ?? []).map((p) => ({
      id: p.id,
      kind: 'piecewise' as const,
      equation: null,
      produces: p.resultSymbol ?? null,
      unit: null,
    })),
    ...(spec?.lookups ?? []).map((l) => ({
      id: l.id,
      kind: 'lookup' as const,
      equation: null,
      produces: l.resultSymbol ?? null,
      unit: null,
    })),
  ];
}

// ─── read ──────────────────────────────────────────────────────────────────

const formula_list: BuiltinToolDef = {
  slug: 'formula_list',
  name: 'List formulas',
  description:
    'List the stored calculation models — id, title, source standard and tags — ordered by title. Returns `total` alongside `formulas`, so a clipped page is never mistaken for the whole set; page with `offset`. Use to find a formula before `formula_get` or `formula_evaluate`. For a conceptual question about what a standard says, `search_nodes` / `search_chunks` search the indexed text instead; this returns the models themselves.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Match against title and spec id, e.g. "release".' },
      standard: {
        type: 'string',
        description: 'Exact source standard, e.g. "API RP 581".',
      },
      tag: { type: 'string', description: 'Single tag filter, e.g. "corrosion".' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Max formulas to return.',
      },
      offset: { type: 'integer', minimum: 0, default: 0, description: 'Rows to skip, for paging.' },
    },
  },
  handler: async (input, ctx) => {
    // Clamp in the handler, not just the schema: arg validation defaults to
    // 'warn', which RECORDS a range violation without repairing it, so
    // `limit: -1` would otherwise reach Postgres as a raw LIMIT error.
    const limit = Math.min(200, Math.max(1, Math.trunc(num(input.limit, 50))));
    const offset = Math.max(0, Math.trunc(num(input.offset, 0)));
    const opts = {
      query: strOpt(input.query),
      standard: strOpt(input.standard),
      tag: strOpt(input.tag),
    };
    const [rows, total] = await Promise.all([
      listFormulas(ctx.ownerId, { ...opts, limit, offset }),
      countFormulas(ctx.ownerId, opts),
    ]);
    return {
      ok: true,
      output: {
        formulas: rows.map(compact),
        total,
        // Self-announcing truncation: a clipped list must never read as complete.
        ...(offset + rows.length < total
          ? { next_offset: offset + rows.length, truncated: true }
          : {}),
      },
    };
  },
};

const formula_get: BuiltinToolDef = {
  slug: 'formula_get',
  name: 'Read a formula',
  description:
    'Return one formula in full: the spec (variables, equations, branches, lookup tables, rating criteria), the list of evaluable `targets` to pass to `formula_evaluate`, and `coverage_gaps` — key combinations a lookup declares as legal but has no row for. **A non-empty `coverage_gaps` means the source table is incomplete, not that the spec is wrong**; say so rather than inventing a value for the missing case.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: "The formula's id (UUID) — from `formula_list`.",
      },
    },
    required: ['id'],
  },
  preconditions: FORMULA_ID_PRE,
  handler: async (input, ctx) => {
    const id = str(input.id);
    const row = await getFormula(ctx.ownerId, id);
    if (!row) return notFound('formula', id, 'formula_list');
    return {
      ok: true,
      output: {
        ...compact(row),
        spec: row.spec,
        targets: targetsOf(row),
        coverage_gaps: checkLookupCoverage(row.spec),
      },
    };
  },
};

// ─── evaluate ──────────────────────────────────────────────────────────────

const formula_evaluate: BuiltinToolDef = {
  slug: 'formula_evaluate',
  name: 'Evaluate a formula',
  description:
    'Compute one target of a formula and return the value plus a `trace` — which branch was taken, which lookup row matched, and what every symbol resolved to. Quote the trace when reporting a number so it can be checked. **Symbols are case-sensitive** (`k` and `K` are different quantities) and a missing or misspelled input is an error, never a zero. Get valid `target` ids and required inputs from `formula_get`.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: "The formula's id (UUID) — from `formula_list`.",
      },
      target: {
        type: 'string',
        description: 'Which target to compute, e.g. "vapor-release-rate" — from `formula_get`.',
      },
      inputs: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values keyed by symbol, e.g. {"Ps": 100, "MW": 30, "Ts": 560}. Overrides constants and defaults.',
      },
    },
    required: ['id', 'target'],
  },
  preconditions: FORMULA_ID_PRE,
  handler: async (input, ctx) => {
    const id = str(input.id);
    const target = str(input.target);
    let spec;
    try {
      spec = await readFormulaSpec(ctx.ownerId, id);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const inputs = (
      typeof input.inputs === 'object' && input.inputs !== null ? input.inputs : {}
    ) as Record<string, FormulaValue>;

    const result = evaluateSpec(spec, target, inputs);
    if (!result.ok) {
      // The evaluator's messages are already corrective ("missing required
      // input 'Pgauge' (lbf/in2)"), so pass them through and add the one thing
      // it cannot know: where to look up the legal targets.
      const targets = [
        ...spec.expressions.map((e) => e.id),
        ...spec.piecewise.map((p) => p.id),
        ...spec.lookups.map((l) => l.id),
      ];
      const hint = targets.includes(target)
        ? ''
        : ` — '${target}' is not a target of this formula; valid targets: ${targets.join(', ')}`;
      // NOT `output: { trace }` — the tool loop serialises a failure as
      // `{ error }` only, so anything in `output` is silently discarded. Fold
      // the derivation into the message or the model never sees how far it got.
      const got = result.trace
        .filter((s) => s.kind === 'symbol')
        .map((s) => `${s.symbol}=${String(s.value)}`)
        .join(', ');
      const resolved = got ? ` Resolved so far: ${got}.` : '';
      return { ok: false, error: `${result.error}${hint}.${resolved}` };
    }
    return { ok: true, output: { value: result.value, target, trace: result.trace } };
  },
};

// ─── write ─────────────────────────────────────────────────────────────────

const SPEC_PARAM_DESC =
  'The full spec object: id, optional name/source/unitSystem/notes, and the arrays variables, expressions, piecewise, lookups, classifications. See docs/formulas.md.';

const formula_create: BuiltinToolDef = {
  slug: 'formula_create',
  name: 'Save a formula',
  description:
    'Store a calculation model transcribed from a standard, so it can be evaluated and cited later. The spec is validated on the way in and **every** problem is returned at once — fix them together and re-issue. Store lookup tables as rows, never as a nested `IF()` chain in an expression. Where the source is ambiguous or self-contradictory, record that in `notes` rather than silently correcting it. Use `formula_update` to revise one already stored.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: { type: 'object', additionalProperties: true, description: SPEC_PARAM_DESC },
      title: { type: 'string', description: 'Optional display name; defaults to spec.name.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation, e.g. ['api-581'].",
      },
    },
    required: ['spec'],
  },
  handler: async (input, ctx) => {
    try {
      const row = await createFormula(ctx.ownerId, {
        spec: input.spec,
        title: strOpt(input.title),
        tags: tagList(input.tags),
      });
      ctx.step?.setOutput({ id: row.id, title: row.title });
      return {
        ok: true,
        output: { ...compact(row), coverage_gaps: checkLookupCoverage(row.spec) },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const formula_update: BuiltinToolDef = {
  slug: 'formula_update',
  name: 'Update a formula',
  description:
    'Patch a stored formula — only the fields you pass change. `spec` replaces the whole model (there is no partial-spec merge), so read it with `formula_get` first, amend, and pass it back whole. A changed spec re-summarises and re-embeds the formula.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: "The formula's id (UUID) — from `formula_list`.",
      },
      spec: { type: 'object', additionalProperties: true, description: SPEC_PARAM_DESC },
      title: { type: 'string', description: 'New display name; omit to keep current.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replaces all tags.' },
    },
    required: ['id'],
  },
  preconditions: FORMULA_ID_PRE,
  handler: async (input, ctx) => {
    const id = str(input.id);
    try {
      const row = await updateFormula(ctx.ownerId, id, {
        ...(input.spec !== undefined ? { spec: input.spec } : {}),
        title: strOpt(input.title),
        ...(input.tags !== undefined ? { tags: tagList(input.tags) } : {}),
      });
      if (!row) return notFound('formula', id, 'formula_list');
      return {
        ok: true,
        output: { ...compact(row), coverage_gaps: checkLookupCoverage(row.spec) },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const formula_delete: BuiltinToolDef = {
  slug: 'formula_delete',
  name: 'Delete a formula',
  description:
    'Permanently delete a stored formula and its brain index. Not reversible. Anything that cited it keeps only the text of the citation.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: "The formula's id (UUID) — from `formula_list`.",
      },
    },
    required: ['id'],
  },
  preconditions: FORMULA_ID_PRE,
  handler: async (input, ctx) => {
    const id = str(input.id);
    const done = await deleteFormula(ctx.ownerId, id);
    if (!done) return notFound('formula', id, 'formula_list');
    return { ok: true, output: { id } };
  },
};

export const FORMULA_TOOLS: BuiltinToolDef[] = [
  formula_list,
  formula_get,
  formula_evaluate,
  formula_create,
  formula_update,
  formula_delete,
];

export const FORMULA_TOOL_SLUGS: readonly string[] = FORMULA_TOOLS.map((t) => t.slug);

/** Read + evaluate + author, but NOT delete (destructive ops are explicit). */
export const FORMULA_AUTO_GRANT_SLUGS: readonly string[] = [
  'formula_list',
  'formula_get',
  'formula_evaluate',
  'formula_create',
  'formula_update',
];
