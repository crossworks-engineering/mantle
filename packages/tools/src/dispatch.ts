/**
 * Tool-call dispatcher. Takes a `tools` row (or just a slug) and an
 * input object; routes to the right handler kind; returns
 * { ok, output } or { ok: false, error }.
 *
 * `builtin` looks up the registered TS function. `http` issues a fetch.
 * `shell` is a future placeholder — returns an error for now until the
 * permissioning story lands.
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
  return { ok: false, error: `unknown handler kind` };
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

  const req = buildHttpRequest(h, input, secrets);
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: AbortSignal.timeout(h.timeoutMs ?? HTTP_TIMEOUT_MS_DEFAULT),
  };
  if (req.body !== null) init.body = req.body;

  try {
    const res = await fetch(req.url, init);
    const text = await res.text();
    ctx.step?.setMeta({ url: scrub(req.url), method: req.method, status: res.status, length: text.length });
    if (!res.ok) {
      return {
        ok: false,
        error: scrub(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`),
      };
    }
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { ok: true, output: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: scrub(msg) };
  }
}
