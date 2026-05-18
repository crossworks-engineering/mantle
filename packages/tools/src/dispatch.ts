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
import { getBuiltinHandler } from './registry';
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
    return {
      ok: false,
      error: 'shell tools are not yet supported (phase 5)',
    };
  }
  return { ok: false, error: `unknown handler kind` };
}

async function dispatchHttp(
  h: Extract<ToolHandler, { kind: 'http' }>,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolHandlerResult> {
  const method = (h.method ?? 'POST').toUpperCase();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Future: h.headersRef / h.authRef → look up secret + inject. For v1
  // these are placeholders — explicit headers/auth land in phase 5.
  void h.headersRef;
  void h.authRef;
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(h.timeoutMs ?? HTTP_TIMEOUT_MS_DEFAULT),
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(input);
  }
  try {
    const res = await fetch(h.url, init);
    const text = await res.text();
    ctx.step?.setMeta({ status: res.status, length: text.length });
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${res.statusText}: ${text.slice(0, 500)}` };
    }
    return { ok: true, output: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
