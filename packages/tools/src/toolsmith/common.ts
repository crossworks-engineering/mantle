/**
 * Shared toolsmith helpers: input coercion, slug/method validation,
 * handler construction, and the authoring-group plumbing.
 *
 * Split out of builtins-toolsmith.ts; bodies moved verbatim.
 */

import { and, eq } from 'drizzle-orm';
import { db, toolGroups, tools, type ToolHandler } from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import { collectParamNames, collectSecretRefs, refKey, type HttpHandler } from '../http-template';
import {
  applyIntegrationInheritance,
  getGroupIntegration,
  type InheritedPieces,
  type ToolGroupIntegration,
} from '../integration';
import { type ToolHandlerResult } from '../types';
import { str } from '../coerce';

export function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function strRecord(
  v: unknown,
  label: string,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const r = rec(v);
  if (!r) return { ok: false, error: `${label} must be an object of string values` };
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) {
    if (typeof val !== 'string') return { ok: false, error: `${label}.${k} must be a string` };
    out[k] = val;
  }
  return { ok: true, value: out };
}

export const SLUG_RE = /^[a-z0-9_-]{1,120}$/;

export const URL_RE = /^https?:\/\/\S+$/i;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Slugs no authored tool may take (final audit F2). `pending_approve` /
 *  `pending_reject` branch on these BEFORE tool resolution — a
 *  `requires_confirm` tool squatting one would let an agent mint pending
 *  rows whose args (`item_id` / `run_id`) reach the runner's answer/budget
 *  paths under an operator click that looks like an ordinary approval.
 *  Neither is a registered tool (by design), so only this reservation
 *  prevents the collision. Owner scoping inside applyHumanAnswer /
 *  applyBudgetDecision is the second layer. */
const RESERVED_PENDING_SLUGS: ReadonlySet<string> = new Set(['ask_human', 'run_budget']);

export function reservedSlugError(slug: string): ToolHandlerResult | null {
  if (!RESERVED_PENDING_SLUGS.has(slug)) return null;
  return {
    ok: false,
    error:
      `slug '${slug}' is reserved for runner-queue approval rows (engine-created; ` +
      `the pending approve/reject handlers branch on it) — pick another slug`,
  };
}

export async function toolRowBySlug(ownerId: string, slug: string) {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, slug)))
    .limit(1);
  return row ?? null;
}

/** Cross-check templates against the declared input schema + the vault.
 *  Returned as `warnings` so the agent can self-correct in the same turn. */
export async function handlerWarnings(
  ownerId: string,
  handler: HttpHandler,
  inputSchema: Record<string, unknown>,
): Promise<string[]> {
  const warnings: string[] = [];
  const props = new Set(Object.keys(rec(inputSchema.properties) ?? {}));
  for (const p of collectParamNames(handler)) {
    if (!props.has(p)) {
      warnings.push(
        `template placeholder {${p}} is not declared in input_schema.properties — the model will never fill it`,
      );
    }
  }
  const refs = collectSecretRefs(handler);
  if (refs.length > 0) {
    const vault = await listApiKeys(ownerId);
    const have = new Set(vault.map((k) => `${k.service}/${k.label}`));
    for (const ref of refs) {
      if (!have.has(refKey(ref))) {
        warnings.push(
          `secret ref {{secret:${refKey(ref)}}} has no matching vault entry — ask the user to add it under Settings → API keys (service '${ref.service}', label '${ref.label}')`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Validate + assemble an http handler from model input. Shared by create/update.
 * Returns an error string on the first problem.
 *
 * When the tool joins an integration group (`opts.integration`), the group's
 * base URL + auth template fold in HERE, at authoring time: a relative `url` is
 * joined onto the base and the group's headers/query merge UNDER the tool's own
 * (the tool wins on conflict). What comes back is what gets STORED, so the
 * dispatcher is untouched and `api_tool_get` shows exactly what will run.
 */
export function buildHandlerFromInput(
  input: Record<string, unknown>,
  opts?: { base?: HttpHandler; integration?: ToolGroupIntegration | null },
): { handler: HttpHandler; inherited: InheritedPieces } | { error: string } {
  const base = opts?.base;
  const url = str(input.url).trim() || base?.url || '';
  const method = (str(input.method).trim() || base?.method || 'POST').toUpperCase();
  if (!METHODS.has(method)) return { error: `method must be one of ${[...METHODS].join(', ')}` };

  let headers = base?.headers;
  if (input.headers !== undefined) {
    const parsed = strRecord(input.headers, 'headers');
    if (!parsed.ok) return { error: parsed.error };
    headers = Object.keys(parsed.value).length > 0 ? parsed.value : undefined;
  }
  let query = base?.query;
  if (input.query !== undefined) {
    const parsed = strRecord(input.query, 'query');
    if (!parsed.ok) return { error: parsed.error };
    query = Object.keys(parsed.value).length > 0 ? parsed.value : undefined;
  }
  let body = base?.body;
  if (input.body !== undefined) {
    if (input.body !== null && typeof input.body !== 'string') {
      return { error: 'body must be a string template (or null to clear)' };
    }
    body = input.body === null || input.body === '' ? undefined : input.body;
  }
  let timeoutMs = base?.timeoutMs;
  if (input.timeout_ms !== undefined) {
    const t = Number(input.timeout_ms);
    if (!Number.isInteger(t) || t < 100 || t > 120_000) {
      return { error: 'timeout_ms must be an integer between 100 and 120000' };
    }
    timeoutMs = t;
  }

  // Inheritance + the absolute-url check in one place: with no group this is
  // exactly the old rule (url must be http(s):// with no spaces); with a group
  // a relative path is joined onto its base and its auth merges underneath.
  const resolved = applyIntegrationInheritance(opts?.integration ?? null, {
    url,
    ...(headers ? { headers } : {}),
    ...(query ? { query } : {}),
  });
  if (!resolved.ok) return { error: resolved.error };

  return {
    handler: {
      kind: 'http',
      url: resolved.url,
      method: method as HttpHandler['method'],
      ...(resolved.headers ? { headers: resolved.headers } : {}),
      ...(resolved.query ? { query: resolved.query } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    inherited: resolved.inherited,
  };
}

/**
 * Resolve `group_slug` on an authoring call: the group must already exist
 * (create it with `tool_group_ensure`), and its integration — if any — is what
 * the tool inherits. Returns null when no group_slug was passed.
 */
export async function resolveAuthoringGroup(
  ownerId: string,
  input: Record<string, unknown>,
): Promise<
  | { ok: true; group: Awaited<ReturnType<typeof getGroupIntegration>> | null }
  | { ok: false; error: string }
> {
  const slug = str(input.group_slug).trim();
  if (!slug) return { ok: true, group: null };
  const group = await getGroupIntegration(ownerId, slug);
  if (!group) {
    return {
      ok: false,
      error: `tool group '${slug}' not found — list the real ones with tool_group_list, or create it (with its service/base_url/secret_ref) using tool_group_ensure before authoring into it`,
    };
  }
  // Connector groups (mcp or openapi) never take hand-authored members:
  // their SYNC owns membership and would drop the addition on its next run.
  if (group.integration?.mcp || group.integration?.openapi) {
    return {
      ok: false,
      error: `'${slug}' is a connector group — its membership is owned by the connector sync; author the tool into a plain integration group instead (tool_group_ensure a new one if needed)`,
    };
  }
  return { ok: true, group };
}

/** Add a tool slug to a group's list (idempotent). The group is known to exist. */
export async function addToolToGroup(
  ownerId: string,
  groupSlug: string,
  toolSlug: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: toolGroups.id, toolSlugs: toolGroups.toolSlugs })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  if (!existing) return;
  const current = existing.toolSlugs ?? [];
  if (current.includes(toolSlug)) return;
  await db
    .update(toolGroups)
    .set({ toolSlugs: [...current, toolSlug], updatedAt: new Date() })
    .where(eq(toolGroups.id, existing.id));
}

/** Vault-presence check for a group's `secret_ref` — a warning, not a failure,
 *  mirroring `api_tool_create`'s missing-ref warning. The owner adds keys. */
export async function integrationWarnings(
  ownerId: string,
  meta: ToolGroupIntegration,
): Promise<string[]> {
  if (!meta.secretRef) return [];
  const vault = await listApiKeys(ownerId);
  const have = new Set(vault.map((k) => `${k.service}/${k.label}`));
  if (have.has(meta.secretRef)) return [];
  const [service, label] = meta.secretRef.split('/');
  return [
    `secret_ref '${meta.secretRef}' has no matching vault entry — ask the owner to add it under Settings → API keys (service '${service}', label '${label}'); until then every tool in this group will fail at call time`,
  ];
}

export function summarizeHandler(h: ToolHandler): Record<string, unknown> {
  if (h.kind === 'http') {
    return {
      kind: 'http',
      url: h.url,
      method: h.method ?? 'POST',
      headers: h.headers ?? {},
      query: h.query ?? {},
      body: h.body ?? null,
      timeoutMs: h.timeoutMs ?? null,
    };
  }
  if (h.kind === 'builtin') return { kind: 'builtin', ref: h.ref };
  if (h.kind === 'mcp') return { kind: 'mcp', group: h.group, toolName: h.toolName };
  if (h.kind === 'recipe') {
    return {
      kind: 'recipe',
      steps: h.steps.map((s) => ({
        tool: s.tool,
        ...(s.as ? { as: s.as } : {}),
        input: s.input ?? {},
      })),
      output: h.output ?? null,
    };
  }
  return { kind: 'shell' };
}

/* ───────────────────────────── web_fetch ─────────────────────────── */
