/**
 * Tool-call dispatcher. Takes a `tools` row (or just a slug) and an
 * input object; routes to the right handler kind; returns
 * { ok, output } or { ok: false, error }.
 *
 * `builtin` looks up the registered TS function. `http` issues a fetch
 * (redirects followed manually so secrets never cross origin — see safeFetch).
 * `shell` runs an operator-authored command; agents can't author or edit shell
 * tools, and console/agent runs go through the same `requiresConfirm` gate.
 */

import { and, eq } from 'drizzle-orm';
import { db, tools, type Tool, type ToolHandler } from '@mantle/db';
import { getApiKey } from '@mantle/api-keys';
import { getBuiltinHandler } from './registry';
import {
  buildHttpRequest,
  collectSecretRefs,
  refKey,
  scrubSecrets,
} from './http-template';
import { safeFetch } from './safe-fetch';
import {
  classifyRecipeStepTool,
  MAX_RECIPE_DEPTH,
  recipeVerdictReason,
  resolveTemplateValue,
  type RecipeScope,
} from './recipe';
import { UNTRUSTED_CONTENT_TOOL_SLUGS } from './untrusted';
import type { ToolHandlerContext, ToolHandlerResult } from './types';

/** Look up a tool by slug for a given owner. Returns null if missing/disabled. */
export async function resolveTool(
  ownerId: string,
  slug: string,
): Promise<Tool | null> {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, slug), eq(tools.enabled, true)))
    .limit(1);
  return row ?? null;
}

/** Resolve a batch of slugs at once. Skips missing/disabled silently. */
export async function resolveTools(
  ownerId: string,
  slugs: string[],
): Promise<Tool[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select()
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.enabled, true)));
  const want = new Set(slugs);
  return rows.filter((r) => want.has(r.slug));
}

const HTTP_TIMEOUT_MS_DEFAULT = 15_000;

export async function dispatchTool(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  /** Internal: recipe-in-recipe nesting depth. Callers leave this 0. */
  depth = 0,
): Promise<ToolHandlerResult> {
  const h = tool.handler as ToolHandler;
  if (h.kind === 'builtin') {
    const fn = getBuiltinHandler(h.ref);
    if (!fn) {
      return {
        ok: false,
        error: `builtin handler '${h.ref}' not registered in this process`,
      };
    }
    try {
      return await fn(input, ctx);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (h.kind === 'http') {
    return dispatchHttp(h, input, ctx);
  }
  if (h.kind === 'shell') {
    return dispatchShell(h, input, ctx);
  }
  if (h.kind === 'recipe') {
    return dispatchRecipe(h, input, ctx, depth);
  }
  return { ok: false, error: `unknown handler kind` };
}

/**
 * Run a recipe handler: each step calls an existing tool, with `{param}` /
 * `$ref` templating threading the recipe input and prior step outputs between
 * calls — all server-side, so values never cross the LLM. The recipe's result
 * is its `output` template (when set) or the last step's output.
 *
 * The safety envelope is re-checked here (not just at authoring time): a step
 * may not call a shell tool, a confirm-gated tool, or a forbidden privilege
 * builtin even if the recipe row was authored before such a tool existed or
 * was later edited. Sub-calls run with NO trace step (so they don't clobber the
 * recipe's own step meta) but keep ownerId + agent context.
 */
async function dispatchRecipe(
  h: Extract<ToolHandler, { kind: 'recipe' }>,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  depth: number,
): Promise<ToolHandlerResult> {
  if (depth >= MAX_RECIPE_DEPTH) {
    return { ok: false, error: `recipe nesting too deep (max ${MAX_RECIPE_DEPTH})` };
  }
  const scope: RecipeScope = { input, steps: {} };
  const subCtx: ToolHandlerContext = { ownerId: ctx.ownerId, agent: ctx.agent };
  const trace: { tool: string; ms: number }[] = [];
  // Provenance: once ANY step pulls third-party content (an http tool, or a
  // web builtin like web_search — which the safety envelope permits), the
  // whole recipe's output is tainted — templating can thread that content
  // into later steps and the final output, so the taint can't be scoped
  // to one step.
  let untrusted = false;

  for (let i = 0; i < h.steps.length; i++) {
    const step = h.steps[i]!;
    const row = await resolveTool(ctx.ownerId, step.tool);
    const verdict = classifyRecipeStepTool({
      slug: step.tool,
      exists: !!row,
      kind: row?.handler.kind,
      requiresConfirm: row?.requiresConfirm,
    });
    if (verdict !== 'ok' || !row) {
      return { ok: false, error: `recipe step ${i}: ${recipeVerdictReason(step.tool, verdict)}` };
    }

    let stepInput: Record<string, unknown>;
    try {
      const resolved = resolveTemplateValue(step.input ?? {}, scope);
      stepInput = (resolved && typeof resolved === 'object' && !Array.isArray(resolved)
        ? resolved
        : {}) as Record<string, unknown>;
    } catch (err) {
      return { ok: false, error: `recipe step ${i} ('${step.tool}'): ${err instanceof Error ? err.message : String(err)}` };
    }

    const t0 = performance.now();
    const res = await dispatchTool(row, stepInput, subCtx, depth + 1);
    trace.push({ tool: step.tool, ms: Math.round(performance.now() - t0) });
    if (!res.ok) {
      return { ok: false, error: `recipe step ${i} ('${step.tool}') failed: ${res.error}` };
    }
    if (res.untrusted || UNTRUSTED_CONTENT_TOOL_SLUGS.has(step.tool)) untrusted = true;
    scope.steps[String(i)] = res.output;
    if (step.as) scope.steps[step.as] = res.output;
  }

  const output =
    h.output !== undefined
      ? resolveTemplateValue(h.output, scope)
      : scope.steps[String(h.steps.length - 1)];
  ctx.step?.setMeta({ recipe_steps: trace, step_count: h.steps.length });
  return { ok: true, output, ...(untrusted ? { untrusted: true } : {}) };
}

const SHELL_TIMEOUT_MS = 30_000;
const SHELL_OUTPUT_CAP = 10 * 1024;

/**
 * Run a shell command template. Placeholders `${input.<field>}` are
 * substituted with shell-escaped values from the input. The command
 * runs via /bin/sh -c with a hard timeout + output cap. stdout +
 * stderr + exit code come back as JSON for the model.
 *
 * NOT a sandbox. The operator owns the cmd template; the model only
 * supplies args. Don't register shell tools you wouldn't paste into
 * your own terminal.
 */
async function dispatchShell(
  h: Extract<ToolHandler, { kind: 'shell' }>,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolHandlerResult> {
  const { exec } = await import('node:child_process');
  const cmd = renderShellCommand(h.cmd, input);
  ctx.step?.setMeta({ cmd });
  return new Promise((resolve) => {
    exec(
      cmd,
      {
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: SHELL_OUTPUT_CAP,
        shell: '/bin/sh',
      },
      (err, stdout, stderr) => {
        const out = String(stdout).slice(0, SHELL_OUTPUT_CAP);
        const errOut = String(stderr).slice(0, SHELL_OUTPUT_CAP);
        if (err) {
          const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          resolve({
            ok: false,
            error: `shell exited with ${exitCode ?? 'error'}: ${err.message}\nstderr:\n${errOut}`,
          });
          return;
        }
        resolve({ ok: true, output: { stdout: out, stderr: errOut, exitCode: 0 } });
      },
    );
  });
}

/** Shell-escape a single value via single-quote wrapping. Internal
 *  single quotes become `'\''`. Non-string values are JSON-stringified. */
function shellEscape(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else s = JSON.stringify(v);
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Substitute `${input.<key>}` in the template with shell-escaped values. */
function renderShellCommand(template: string, input: Record<string, unknown>): string {
  return template.replace(/\$\{input\.([a-zA-Z0-9_]+)\}/g, (_, key: string) =>
    shellEscape(input[key]),
  );
}

/** Decrypt every `{{secret:service/label}}` ref the handler's templates
 *  mention. Missing vault entries fail the call up-front with a clear
 *  message instead of sending a request with a literal ref in it. */
async function resolveHandlerSecrets(
  ownerId: string,
  h: Extract<ToolHandler, { kind: 'http' }>,
): Promise<{ secrets: Map<string, string> } | { error: string }> {
  const secrets = new Map<string, string>();
  for (const ref of collectSecretRefs(h)) {
    const plaintext = await getApiKey(ownerId, ref.service, ref.label);
    if (plaintext === null) {
      return {
        error: `secret '${refKey(ref)}' not found in the API-key vault — add it under Settings → API keys (service '${ref.service}', label '${ref.label}')`,
      };
    }
    secrets.set(refKey(ref), plaintext);
  }
  return { secrets };
}

async function dispatchHttp(
  h: Extract<ToolHandler, { kind: 'http' }>,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolHandlerResult> {
  const resolved = await resolveHandlerSecrets(ctx.ownerId, h);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const { secrets } = resolved;
  const scrub = (s: string) => scrubSecrets(s, secrets);

  try {
    // Inside the try: buildHttpRequest can throw (e.g. encodeURIComponent on a
    // lone surrogate in model input) and must surface as a scrubbed error, not
    // an unhandled rejection out of the dispatcher.
    const req = buildHttpRequest(h, input, secrets);
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      signal: AbortSignal.timeout(h.timeoutMs ?? HTTP_TIMEOUT_MS_DEFAULT),
    };
    if (req.body !== null) init.body = req.body;

    const res = await safeFetch(req.url, init, [...secrets.values()]);
    const text = await res.text();
    ctx.step?.setMeta({ url: scrub(req.url), method: req.method, status: res.status, length: text.length });
    if (!res.ok) {
      return {
        ok: false,
        error: scrub(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`),
      };
    }
    // Scrub the raw text BEFORE parsing so any secret an upstream reflects
    // back (echo endpoints, debug payloads, mirrored auth headers) is replaced
    // in the parsed object too — the plaintext must never reach the model.
    const scrubbed = scrub(text);
    let parsed: unknown = scrubbed;
    try {
      parsed = JSON.parse(scrubbed);
    } catch {
      /* keep raw text */
    }
    // Every http result is third-party authored — flag it so the tool-loop
    // fences it as data before the model reads it.
    return { ok: true, output: parsed, untrusted: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: scrub(msg) };
  }
}
