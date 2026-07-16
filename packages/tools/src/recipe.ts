/**
 * Recipe tools — the "Tier 1" runtime-authorable tool kind. A recipe is a
 * declarative chain of EXISTING tools: each step calls one tool, and a later
 * step can reference an earlier step's output. The data flows between steps
 * server-side (inside dispatch), so a value like a note body never round-trips
 * through the LLM — the whole point of `page_from_note` and its kin, but
 * composed at runtime by an agent (Toolsmith) instead of compiled into the image.
 *
 * This module is PURE — templating + validation + the safety envelope. The
 * executor lives in dispatch.ts (it needs resolveTool + dispatchTool), so this
 * file has no DB/dispatch imports and stays trivially testable.
 *
 * Safety envelope (enforced at BOTH author time and run time): a recipe step
 * may only call http / builtin / recipe tools that are NOT confirm-gated,
 * NOT shell, and NOT one of the privilege/meta builtins in
 * RECIPE_FORBIDDEN_SLUGS. That keeps a recipe to composing the brain's own
 * data/content tools — it can't bypass a confirm gate, shell out, mint or
 * grant tools, delegate, or touch secrets.
 */

import type { RecipeStep } from '@mantle/db';

export type { RecipeStep };

/** Max steps in a single recipe (author-time + parse guard). */
export const MAX_RECIPE_STEPS = 24;
/** Max recipe-in-recipe nesting depth (run-time recursion guard). */
export const MAX_RECIPE_DEPTH = 4;

/**
 * Builtins a recipe step may NOT call. These are the privilege / meta / escape
 * surfaces — composing them would let an agent-authored recipe escalate past
 * the "agents author safe compositions only" boundary. Shell-kind tools and
 * any confirm-gated tool are refused separately (by kind / flag), so this set
 * is only the dangerous *builtins* (which are kind:'builtin', not 'shell').
 */
export const RECIPE_FORBIDDEN_SLUGS: ReadonlySet<string> = new Set([
  // shell-equivalent / host escape
  'run_terminal',
  // secrets + privilege
  'secret_create',
  'update_persona',
  // delegation / recursion into other agents
  'invoke_agent',
  // tool-authoring + grant kit (minting/granting capability)
  'api_tool_create',
  'api_tool_update',
  'api_tool_delete',
  'api_tool_test',
  'api_tool_list',
  'api_tool_get',
  'api_key_refs',
  'tool_group_ensure',
  'tool_group_list',
  'agent_list',
  'agent_grant_tool_group',
  'web_fetch',
  // recipe authoring itself (no self-referential authoring from inside a recipe)
  'tool_catalog',
  'recipe_tool_create',
  'recipe_tool_test',
]);

/** Handler kinds that an agent may bundle into a group + grant. http (Toolsmith
 *  classic) and recipe (Tier 1). Shell + builtin stay operator/manifest-owned. */
export const AGENT_GRANTABLE_KINDS: ReadonlySet<string> = new Set(['http', 'recipe']);

/* ───────────────────────────── templating ───────────────────────────── */

const EXACT_PARAM_RE = /^\{([a-zA-Z0-9_]+)\}$/;
const EXACT_REF_RE = /^\$([a-zA-Z0-9_]+)((?:\.[a-zA-Z0-9_]+)*)$/;
const EMBED_PARAM_RE = /\{([a-zA-Z0-9_]+)\}/g;
const EMBED_REF_RE = /\$\{([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\}/g;

export type RecipeScope = {
  /** the recipe call's own input object */
  input: Record<string, unknown>;
  /** prior step outputs, keyed by 0-based index ("0","1") AND by `as` name */
  steps: Record<string, unknown>;
};

/** Thrown when a `$ref` names a step that hasn't produced output (yet). */
export class RecipeRefError extends Error {}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Walk a dotted path (`name.a.b`) into the step-output scope. The first
 *  segment names the step; an unknown step name is an error (likely an authoring
 *  typo); a path into a present-but-shapeless value yields undefined (lenient). */
function resolveRef(ref: string, scope: RecipeScope): unknown {
  const [head, ...rest] = ref.split('.') as [string, ...string[]];
  if (!(head in scope.steps)) {
    throw new RecipeRefError(
      `recipe references $${ref} but step '${head}' has no output (steps so far: ${
        Object.keys(scope.steps)
          .filter((k) => !/^\d+$/.test(k))
          .join(', ') || '—'
      })`,
    );
  }
  let cur: unknown = scope.steps[head];
  for (const seg of rest) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Resolve one template value against the recipe scope. An EXACT `{param}` or
 *  `$ref` returns the raw typed value (object, array, number…), preserving
 *  shape between steps. Anything else is treated as a string template:
 *  embedded `{param}` and `${ref}` tokens are substituted (stringified). */
export function resolveTemplateValue(value: unknown, scope: RecipeScope): unknown {
  if (typeof value === 'string') {
    const pm = EXACT_PARAM_RE.exec(value);
    if (pm) return scope.input[pm[1]!];
    const rm = EXACT_REF_RE.exec(value);
    if (rm) return resolveRef(rm[1]! + (rm[2] ?? ''), scope);
    return value
      .replace(EMBED_REF_RE, (_m, ref: string) => stringify(resolveRef(ref, scope)))
      .replace(EMBED_PARAM_RE, (_m, name: string) => stringify(scope.input[name]));
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplateValue(v, scope));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTemplateValue(v, scope);
    }
    return out;
  }
  return value;
}

/** Collect every `{param}` token referenced across a recipe's step inputs +
 *  output template. Used to warn when a step references a param the recipe's
 *  input_schema doesn't declare (the model would never fill it). */
export function collectRecipeParams(steps: RecipeStep[], output: unknown): Set<string> {
  const params = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === 'string') {
      const pm = EXACT_PARAM_RE.exec(v);
      if (pm) {
        params.add(pm[1]!);
        return;
      }
      for (const m of v.matchAll(EMBED_PARAM_RE)) params.add(m[1]!);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(scan);
      return;
    }
    if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(scan);
  };
  for (const s of steps) scan(s.input ?? {});
  if (output !== undefined) scan(output);
  return params;
}

/* ───────────────────────────── validation ───────────────────────────── */

const STEP_AS_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Parse + structurally validate raw `steps` input from a tool call. Does not
 *  check that referenced tools exist or are allowed — that needs the registry
 *  (done by the authoring builtin). Returns normalized steps or an error. */
export function parseRecipeSteps(raw: unknown): { steps: RecipeStep[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'steps must be a non-empty array' };
  }
  if (raw.length > MAX_RECIPE_STEPS) {
    return { error: `steps may have at most ${MAX_RECIPE_STEPS} entries (got ${raw.length})` };
  }
  const steps: RecipeStep[] = [];
  const names = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { error: `step ${i} must be an object` };
    }
    const obj = s as Record<string, unknown>;
    const tool = typeof obj.tool === 'string' ? obj.tool.trim() : '';
    if (!tool) return { error: `step ${i} is missing a 'tool' slug` };
    let input: Record<string, unknown> | undefined;
    if (obj.input !== undefined) {
      if (!obj.input || typeof obj.input !== 'object' || Array.isArray(obj.input)) {
        return { error: `step ${i} ('${tool}') input must be an object` };
      }
      input = obj.input as Record<string, unknown>;
    }
    let as: string | undefined;
    if (obj.as !== undefined) {
      if (typeof obj.as !== 'string' || !STEP_AS_RE.test(obj.as)) {
        return {
          error: `step ${i} ('${tool}') 'as' must be a name like 'note' (letter then letters/digits/_)`,
        };
      }
      if (/^\d+$/.test(obj.as))
        return { error: `step ${i} 'as' cannot be a number (those are reserved for indices)` };
      if (names.has(obj.as))
        return { error: `step ${i} reuses the name '${obj.as}' — names must be unique` };
      names.add(obj.as);
      as = obj.as;
    }
    steps.push({ tool, ...(input ? { input } : {}), ...(as ? { as } : {}) });
  }
  return { steps };
}

export type RecipeStepVerdict = 'ok' | 'missing' | 'forbidden' | 'shell' | 'confirm';

/** Decide whether a recipe step is allowed to call a given tool. The single
 *  source of truth for the safety envelope, shared by the authoring builtin
 *  (reject up-front, all violations at once) and the executor (defense-in-depth,
 *  in case a tool was edited after the recipe was authored). */
export function classifyRecipeStepTool(opts: {
  slug: string;
  exists: boolean;
  kind?: string;
  requiresConfirm?: boolean;
}): RecipeStepVerdict {
  if (!opts.exists) return 'missing';
  if (RECIPE_FORBIDDEN_SLUGS.has(opts.slug)) return 'forbidden';
  if (opts.kind === 'shell') return 'shell';
  if (opts.requiresConfirm) return 'confirm';
  return 'ok';
}

/** Human-readable reason for a non-'ok' verdict, for tool error messages. */
export function recipeVerdictReason(slug: string, v: RecipeStepVerdict): string {
  switch (v) {
    case 'missing':
      return `'${slug}' does not exist — browse tool_catalog for valid slugs`;
    case 'forbidden':
      return `'${slug}' can't be used in a recipe (terminal/secrets/delegation/tool-authoring are off-limits)`;
    case 'shell':
      return `'${slug}' is a shell tool — recipes can't call shell tools`;
    case 'confirm':
      return `'${slug}' is confirm-gated — recipes can't call tools that require approval`;
    case 'ok':
      return '';
  }
}
