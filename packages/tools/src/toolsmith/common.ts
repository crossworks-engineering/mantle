/**
 * Shared toolsmith helpers: input coercion, slug/method validation,
 * handler construction, and the authoring-group plumbing.
 */

import { and, arrayOverlaps, eq, sql } from 'drizzle-orm';
import {
  agents,
  db,
  onFullSystemRoute,
  parkPendingCall,
  toolGroups,
  tools,
  type ToolHandler,
} from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import { listToolsForOwner } from '../crud';
import { notifyPendingCreated } from '../pending-notify';
import { pendingOriginOfCaller } from '../pending-origin';
import { AGENT_GRANTABLE_KINDS } from '../recipe';
import {
  collectOauthRefs,
  collectParamNames,
  collectSecretRefs,
  refKey,
  type HttpHandler,
} from '../http-template';
import {
  applyIntegrationInheritance,
  getGroupIntegration,
  type InheritedPieces,
  type ToolGroupIntegration,
} from '../integration';
import { type ToolHandlerContext, type ToolHandlerResult } from '../types';
import { str } from '../coerce';
import { isPersonCall, isPersonOnlyTool } from '../person-only-acts';
import { restampHeartbeatMakers } from '../heartbeat-maker';
import { toolMaker } from '../secret-ref-gate';
import { builtinPolicy } from '../tool-policy';

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

/** Slugs no authored tool may take. An approval or a `pending_reject`
 *  branches on these BEFORE tool resolution: a
 *  `requires_confirm` tool squatting one would let an agent mint pending
 *  rows whose args (`item_id` / `run_id`) reach the runner's answer/budget
 *  paths under an operator click that looks like an ordinary approval.
 *  Neither is a registered tool (by design), so only this reservation
 *  prevents the collision. Owner scoping inside applyHumanAnswer /
 *  applyBudgetDecision is the second layer. */
const RESERVED_PENDING_SLUGS: ReadonlySet<string> = new Set(['ask_human', 'run_budget']);

export function reservedSlugError(slug: string): ToolHandlerResult | null {
  // A person's act (person-only-acts.ts) is no tool's: one by its name would
  // read to an agent as a way to do it.
  if (isPersonOnlyTool(slug)) {
    return {
      ok: false,
      error: `slug '${slug}' is reserved: it names an act a person does in the app, and no tool does. Pick another slug`,
    };
  }
  // A builtin's name, an MCP-only one too: that name means the builtin, here
  // and in an approval (a held vault tool's runs the vault's own tool).
  if (builtinPolicy(slug)) {
    return {
      ok: false,
      error: `slug '${slug}' is a built-in tool's name, and an authored tool cannot take it: pick another slug`,
    };
  }
  if (!RESERVED_PENDING_SLUGS.has(slug)) return null;
  return {
    ok: false,
    error:
      `slug '${slug}' is reserved for runner-queue approval rows (engine-created; ` +
      `the pending approve/reject handlers branch on it) — pick another slug`,
  };
}

/** A test tool's refusal of a tool that is off: a test runs it for real. */
export function switchedOffError(slug: string): string {
  return `tool '${slug}' is switched off, so a test cannot run it. A person turns it back on in Settings > Tools; then test it again`;
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
  for (const slug of collectOauthRefs(handler)) {
    const [group] = await db
      .select({ integration: toolGroups.integration })
      .from(toolGroups)
      .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, slug)))
      .limit(1);
    if (!group?.integration?.oauth2) {
      warnings.push(
        `oauth ref {{oauth:${slug}}} names no group with oauth2 configured. Set oauth2 on group '${slug}' with tool_group_ensure, or every call fails`,
      );
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

/** A door's answer: go on, or answer the call with `result`. */
type Door = { open: true } | { open: false; result: ToolHandlerResult };

const DOOR_OPEN: Door = { open: true };

/**
 * The one park of a Toolsmith call that waits for a person: a change to a group
 * another workspace holds (heldGroupDoor), a grant, a thinking effort, a test of
 * a tool with the confirm flag. Stamped with the scope the asking call runs in,
 * whether or not this call left it for the system pool, and asked by the login
 * that stamp names: an approval reads the two
 * together. An asker with no agent on its context parks with no agent, and the
 * stamp still names its login, or the anchor decides. `why` opens the message
 * the asker reads.
 */
async function parkAgentCall(
  ctx: ToolHandlerContext,
  call: { toolSlug: string; args: Record<string, unknown> },
  why: string,
): Promise<ToolHandlerResult> {
  const slug = ctx.agent?.slug;
  const [requester] = slug
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, slug)))
        .limit(1)
    : [];
  const origin = await pendingOriginOfCaller(ctx.surface);
  const asker = origin.surface?.loginId;
  // The turn read text a client wrote: the row, its card and /pending say so,
  // whatever made the call wait (as the turn's confirm gate, execute-call.ts).
  const taint = ctx.agent?.taint;
  const clientSourced =
    taint?.clientSourced === true
      ? { via: (taint.via ?? 'text a client wrote').slice(0, 200) }
      : null;
  const pendingId = await parkPendingCall({
    ownerId: ctx.ownerId,
    agentId: requester?.id ?? null,
    toolSlug: call.toolSlug,
    args: call.args,
    origin,
    ...(asker ? { loginId: asker } : {}),
    ...(clientSourced ? { clientSourced } : {}),
  });
  if (pendingId) {
    void notifyPendingCreated({
      ownerId: ctx.ownerId,
      pendingId,
      toolSlug: call.toolSlug,
      args: call.args,
      ...(slug ? { via: `agent ${slug}` } : {}),
      ...(clientSourced ? { clientSourced } : {}),
    });
  }
  return {
    ok: true,
    output: {
      status: 'queued_for_approval',
      pending_id: pendingId,
      message: `${why} Queued at /pending; it applies once approved. Do not retry this turn.`,
    },
  };
}

/**
 * Who need not wait, by the caller's entry alone: a person (the dev tool console,
 * an approved call) and an MCP client (owner, 2026-11-07).
 */
export function actsAtOnce(ctx: ToolHandlerContext): boolean {
  return isPersonCall(ctx) || ctx.caller?.entry === 'mcp';
}

/**
 * The answer to a call that may not act at once. An in-brain agent (a turn, a run
 * item) waits in Pending, and on approval the call runs again as a person's.
 * Anything else (an app, a /api/v1 route) has no one to wait with, so it is refused
 * rather than queued.
 */
export async function waitForPerson(
  ctx: ToolHandlerContext,
  call: { toolSlug: string; args: Record<string, unknown> },
  why: string,
): Promise<ToolHandlerResult> {
  const entry = ctx.caller?.entry;
  if (entry !== 'turn' && entry !== 'run') {
    return {
      ok: false,
      error: `${why} This call cannot wait for approval. Ask a person to make the change in Settings > Tools, or ask an assistant, whose change waits in Pending.`,
    };
  }
  return parkAgentCall(ctx, call, why);
}

/** The end of a new tool's `next` line, as true with the owner's setting on. */
export const TEST_MAY_WAIT =
  "On a tool with requires_confirm on, an in-brain agent's test returns queued_for_approval: report it as pending at /pending, do not retry.";

/**
 * The groups a change to a tool's row reaches: those whose list names it, and
 * those whose list names a recipe that steps through it, at any depth.
 */
export async function groupsHoldingTool(ownerId: string, toolSlug: string): Promise<string[]> {
  const rows = await db
    .select({ slug: toolGroups.slug })
    .from(toolGroups)
    .where(
      and(
        eq(toolGroups.ownerId, ownerId),
        sql`${toolGroups.toolSlugs} && (
          with recursive reached(slug) as (
            select ${toolSlug}::text
            union
            select t.slug
              from "public"."tools" t
              cross join lateral jsonb_array_elements(
                case when jsonb_typeof(t.handler->'steps') = 'array'
                     then t.handler->'steps' else '[]'::jsonb end
              ) as step
              join reached r on r.slug = step->>'tool'
             where t.owner_id = ${ownerId} and t.handler->>'kind' = 'recipe'
          )
          select array_agg(slug) from reached
        )`,
      ),
    );
  return rows.map((g) => g.slug);
}

/**
 * The one rule (owner, 2026-11-07): a change to what a group gives its holders
 * reaches the users of any other workspace whose assistant holds it, so every
 * Toolsmith write that makes one asks here once, with the groups it changes
 * (a group that does not exist yet counts: a grant may already name it).
 *
 * Who, by the caller's entry alone: a person (the dev tool console, an approved
 * call) and an MCP client act at once. An in-brain agent (a turn, a run item)
 * waits in Pending, and on approval the call runs again as a person's. Anything
 * else (an app, a /api/v1 route) has no one to wait with, so it is refused rather
 * than queued.
 */
export async function heldGroupDoor(
  ctx: ToolHandlerContext,
  groups: readonly string[],
  heldCall: { toolSlug: string; args: Record<string, unknown> },
): Promise<Door> {
  if (groups.length === 0 || actsAtOnce(ctx)) return DOOR_OPEN;
  const [holder] = await db
    .select({ groups: agents.toolGroupSlugs })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ctx.ownerId),
        arrayOverlaps(agents.toolGroupSlugs, [...groups]),
        sql`${agents.workspaceId} is not null`,
        sql`not exists (select 1 from "public"."workspaces" w
                         where w.id = ${agents.workspaceId} and w.is_admin)`,
      ),
    )
    .limit(1);
  if (!holder) return DOOR_OPEN;
  const group = groups.find((g) => holder.groups?.includes(g)) ?? groups[0];
  const held = `'${group}' is held by an assistant of another workspace than Admin`;
  return {
    open: false,
    result: await waitForPerson(
      ctx,
      heldCall,
      `${held}: changing what it gives them needs operator approval.`,
    ),
  };
}

/**
 * Why a group may not take these tools, or null: a group takes only http and
 * recipe tools that exist, for every caller of the tools. A person's route takes
 * any tool. A connector's mirrored tool stays in its connector's group: the sync
 * owns that list. Asked before anything is written, and before heldGroupDoor: a
 * call that cannot run never waits.
 */
export async function groupListRefusal(
  ownerId: string,
  requested: readonly string[],
): Promise<ToolHandlerResult | null> {
  const ownerTools = await listToolsForOwner(ownerId);
  const handlerBySlug = new Map(ownerTools.map((t) => [t.slug, t.handler] as const));
  const noRow = requested.filter((s) => !handlerBySlug.has(s));
  const wrongKind = requested.filter((s) => {
    const h = handlerBySlug.get(s);
    return h && (!AGENT_GRANTABLE_KINDS.has(h.kind) || (h.kind === 'http' && !!h.openapi));
  });
  if (noRow.length === 0 && wrongKind.length === 0) return null;
  const absent =
    noRow.length > 0
      ? ` No tool has the slug ${noRow.join(', ')}: make it first with api_tool_create or recipe_tool_create (api_tool_list shows the real ones), then add it.`
      : '';
  return {
    ok: false,
    error: `tool groups may only contain http or recipe tools (connector-mirrored tools stay in their own connector group); refused: ${[...wrongKind, ...noRow].join(', ')}.${absent}`,
  };
}

/** Add a tool slug to a group's list (idempotent). The group is known to exist,
 *  and the call has passed its door. The tool's holders' heartbeats now run
 *  it: they become the caller's (heartbeat-maker.ts), as on tool_group_ensure. */
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
  // A tool added to a group: the full-route spot tool-group-grant on a
  // narrow exit (the narrow login holds no write of tool_slugs).
  await onFullSystemRoute('tool-group-grant', () =>
    db
      .update(toolGroups)
      .set({ toolSlugs: [...current, toolSlug], updatedAt: new Date() })
      .where(eq(toolGroups.id, existing.id)),
  );
  await restampHeartbeatMakers(ownerId, toolMaker(ownerId), { toolGroupSlug: groupSlug });
}

/** Vault-presence check for a group's `secret_ref` — a warning, not a failure,
 *  mirroring `api_tool_create`'s missing-ref warning. The owner adds keys. */
export async function integrationWarnings(
  ownerId: string,
  meta: ToolGroupIntegration,
): Promise<string[]> {
  const refs: Array<[string, string]> = [];
  if (meta.secretRef) refs.push(['secret_ref', meta.secretRef]);
  if (meta.oauth2) {
    refs.push(['oauth2.client_id_ref', meta.oauth2.clientIdRef]);
    refs.push(['oauth2.client_secret_ref', meta.oauth2.clientSecretRef]);
  }
  if (refs.length === 0) return [];
  const vault = await listApiKeys(ownerId);
  const have = new Set(vault.map((k) => `${k.service}/${k.label}`));
  return refs
    .filter(([, ref]) => !have.has(ref))
    .map(([field, ref]) => {
      const [service, label] = ref.split('/');
      return `${field} '${ref}' has no matching vault entry — ask the owner to add it under Settings → API keys (service '${service}', label '${label}'); until then every tool in this group will fail at call time`;
    });
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
