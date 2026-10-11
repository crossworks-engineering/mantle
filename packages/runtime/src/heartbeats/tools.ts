/**
 * The 5 heartbeat-control builtins. Live in @mantle/heartbeats rather
 * than @mantle/tools because they need the AsyncLocalStorage context
 * and the fire orchestrator — depending on those from @mantle/tools
 * would invert the dependency graph (heartbeats already depends on
 * tools, not the other way round).
 *
 * Registration: call `registerHeartbeatTools()` from server/api (and
 * server/web's runtime if web ever fires heartbeats) at boot, BEFORE
 * `seedBuiltinTools(ownerId)` runs — the seed iterates the registry.
 *
 * Dual-mode addressing (slug arg vs ALS context)
 * ──────────────────────────────────────────────
 * heartbeat_update_state / heartbeat_complete / heartbeat_snooze all
 * need to know which heartbeat to mutate. There are two contexts
 * they get called from:
 *
 *   1. Inside a heartbeat fire (`withHeartbeatContext` ALS scope):
 *      the firing heartbeat is unambiguous. Slug arg is optional.
 *
 *   2. Inside a responder turn that's reacting to a user reply to a
 *      previously-asked heartbeat question. The responder's tool
 *      loop is NOT wrapped in withHeartbeatContext (different
 *      lifecycle), so the ALS lookup returns null. The model MUST
 *      pass the slug arg explicitly. The awareness block injected
 *      into the responder's system prompt lists each open
 *      heartbeat's slug so the model knows what to pass.
 *
 * Resolution order: explicit slug arg → ALS context → error.
 * Ownership scoping is enforced in both paths via ctx.ownerId.
 *
 * heartbeat_list takes no addressing (lists all). heartbeat_fire
 * takes a required slug (the operator/skill picks who to fire).
 */

import { and, eq } from 'drizzle-orm';
import {
  asSystem,
  db,
  heartbeats,
  scopeHasArea,
  scopeHoldsAdmin,
  withTurnScope,
  type Heartbeat,
} from '@mantle/db';
import { currentRequestMode, currentWorkspaceScope, scopeLeftForSystem } from '@mantle/db/viewer';
import {
  adminAreaError,
  areaSystem,
  ownerSurfaceLoginId,
  registerBuiltin,
  type BuiltinToolDef,
  type ToolHandlerContext,
  type ToolHandlerResult,
} from '@mantle/tools';
import { currentHeartbeat, MAX_HEARTBEAT_DEPTH } from './context';
import { forceFire } from './fire';
import { computeNextFireAt } from './schedule';

/**
 * The heartbeats table is the owner's configuration: the workspace role
 * reads none of it. A heartbeat of a non-Admin workspace (its fire runs in a
 * turn scope, W4b fix round 1) reaches only the row of the heartbeat that is
 * firing (resolveTargetHeartbeat refuses any other), on the system pool with
 * a named reason. In a scope that holds Admin (the Admin assistant, W7a) the
 * owner's heartbeats as before, on the system pool after the assistants
 * area check (resolveTargetHeartbeat). Outside a workspace scope: as before.
 */
async function heartbeatRow<T>(fn: () => Promise<T>): Promise<T> {
  if (!currentWorkspaceScope()) return fn();
  if (await scopeHoldsAdmin()) return asSystem(fn, 'admin-area');
  return asSystem(fn, 'heartbeat-own-row');
}

/**
 * The login a heartbeat tool call answers, as heartbeats.created_by and
 * heartbeat_fires.answered_by store it (W7 integration fix 2, H1): the login
 * of the caller's scope (or of the scope its area work left for the system
 * pool), else the login its owner surface names; null for the brain owner
 * (the anchor login) and for a call that names none (the anchor's stdio MCP,
 * a brain not on workspaces).
 */
function callerLogin(ctx: Pick<ToolHandlerContext, 'ownerId' | 'surface'>): string | null {
  const scope = currentWorkspaceScope() ?? scopeLeftForSystem();
  const login = scope ? scope.loginId : ownerSurfaceLoginId(ctx.surface);
  return login && login.toLowerCase() !== ctx.ownerId.toLowerCase() ? login : null;
}

async function loadOwnedHeartbeatById(ownerId: string, id: string): Promise<Heartbeat | null> {
  const [row] = await db
    .select()
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, ownerId), eq(heartbeats.id, id)))
    .limit(1);
  return row ?? null;
}

async function loadOwnedHeartbeatBySlug(ownerId: string, slug: string): Promise<Heartbeat | null> {
  const [row] = await db
    .select()
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, ownerId), eq(heartbeats.slug, slug)))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve which heartbeat a mutation tool should act on.
 *  - If `input.slug` is set, that wins (responder-turn path).
 *  - Otherwise fall back to `currentHeartbeat()` from ALS (fire-path).
 *  - If neither, return null with a clear error string.
 * Ownership scoping happens here too: a slug from one owner can never
 * resolve to a row from another (we filter by ctx.ownerId).
 */
async function resolveTargetHeartbeat(
  input: Record<string, unknown>,
  ownerId: string,
): Promise<{ ok: true; hb: Heartbeat; via: 'slug' | 'als' } | { ok: false; error: string }> {
  const slugInput = typeof input.slug === 'string' && input.slug.trim() ? input.slug.trim() : null;
  const scoped = currentWorkspaceScope() !== null;
  const adminScope = scoped && (await scopeHoldsAdmin());
  if (adminScope && !(await scopeHasArea('assistants'))) {
    return { ok: false, error: adminAreaError('assistants') };
  }
  if (scoped && !adminScope) {
    // A workspace turn: only the heartbeat that is firing, never another.
    const firing = currentHeartbeat();
    if (!firing || (slugInput && slugInput !== firing.slug)) {
      return {
        ok: false,
        error: 'In this workspace a heartbeat tool changes only the heartbeat that is firing.',
      };
    }
    const hb = await heartbeatRow(() => loadOwnedHeartbeatById(ownerId, firing.heartbeatId));
    if (!hb) return { ok: false, error: 'heartbeat row not found (race?)' };
    return { ok: true, hb, via: 'als' };
  }
  if (slugInput) {
    const hb = await heartbeatRow(() => loadOwnedHeartbeatBySlug(ownerId, slugInput));
    if (!hb) return { ok: false, error: `heartbeat '${slugInput}' not found for this owner` };
    return { ok: true, hb, via: 'slug' };
  }
  const ctx = currentHeartbeat();
  if (ctx) {
    const hb = await heartbeatRow(() => loadOwnedHeartbeatById(ownerId, ctx.heartbeatId));
    if (!hb) return { ok: false, error: 'heartbeat row not found (race?)' };
    return { ok: true, hb, via: 'als' };
  }
  return {
    ok: false,
    error:
      'no heartbeat context: call from inside a heartbeat fire, or pass `slug` ' +
      'explicitly (e.g. when reacting to a user reply mentioned in the open-heartbeat awareness block).',
  };
}

const heartbeat_complete: BuiltinToolDef = {
  slug: 'heartbeat_complete',
  name: 'Mark a heartbeat complete',
  description:
    'Permanently stop a heartbeat. Use this when the skill has accomplished what it set out to do (e.g. all interview questions answered) OR when the user explicitly asks you to stop. Pass `slug` to target a specific heartbeat — required when called from a regular responder turn; optional inside a heartbeat fire (the firing one is the default). After this call, the heartbeat never fires again unless an operator re-activates it. Takes an optional `reason` string stored on the row for the operator to see.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'Heartbeat slug to complete. Required when not inside a heartbeat fire. Inside a fire, omit to default to the firing heartbeat.',
      },
      reason: {
        type: 'string',
        description:
          "Short free-text explanation of why the heartbeat is being completed, e.g. 'all topics covered' or 'user asked to stop'.",
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const target = await resolveTargetHeartbeat(input, ctx.ownerId);
    if (!target.ok) {
      ctx.step?.setMeta({ branch: 'no_target', error: target.error });
      return { ok: false, error: target.error };
    }
    const reason = typeof input.reason === 'string' ? input.reason : 'completed_by_agent';
    await heartbeatRow(() =>
      db
        .update(heartbeats)
        .set({
          status: 'completed',
          completionReason: `tool_call:${reason}`,
          nextFireAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeats.id, target.hb.id), eq(heartbeats.ownerId, ctx.ownerId))),
    );
    ctx.step?.setMeta({ branch: 'completed', via: target.via, heartbeat_id: target.hb.id, reason });
    return {
      ok: true,
      output: { heartbeat_id: target.hb.id, slug: target.hb.slug, status: 'completed', reason },
    };
  },
};

const heartbeat_snooze: BuiltinToolDef = {
  slug: 'heartbeat_snooze',
  name: 'Snooze a heartbeat',
  description:
    "Push a heartbeat's next fire forward without completing it. Pass `slug` to target a specific heartbeat — required from a regular responder turn; optional inside a heartbeat fire (firing one is the default). Specify the delay via `for_hours` (e.g. 24 = try again tomorrow) or `until` (ISO-8601 instant). Useful when the user is busy or the moment isn't right but the heartbeat should keep trying.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'Heartbeat slug to snooze. Required when not inside a heartbeat fire.',
      },
      for_hours: { type: 'number', description: 'How many hours from now to defer.' },
      until: { type: 'string', description: 'ISO-8601 instant to defer until.' },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    // Cheap checks first (no IO), then DB-touching addressing, then
    // DB write. Lets the LLM iterate on argument shape without
    // burning DB round-trips on each retry.
    let next: Date;
    if (typeof input.until === 'string') {
      const t = new Date(input.until);
      if (Number.isNaN(t.getTime())) {
        ctx.step?.setMeta({ branch: 'bad_until' });
        return { ok: false, error: 'invalid until iso' };
      }
      next = t;
    } else if (typeof input.for_hours === 'number' && input.for_hours > 0) {
      next = new Date(Date.now() + input.for_hours * 3600_000);
    } else {
      ctx.step?.setMeta({ branch: 'bad_delay' });
      return { ok: false, error: 'pass either for_hours (>0) or until (ISO-8601)' };
    }
    const target = await resolveTargetHeartbeat(input, ctx.ownerId);
    if (!target.ok) {
      ctx.step?.setMeta({ branch: 'no_target', error: target.error });
      return { ok: false, error: target.error };
    }
    await heartbeatRow(() =>
      db
        .update(heartbeats)
        .set({ nextFireAt: next, updatedAt: new Date() })
        .where(and(eq(heartbeats.id, target.hb.id), eq(heartbeats.ownerId, ctx.ownerId))),
    );
    ctx.step?.setMeta({
      branch: 'snoozed',
      via: target.via,
      heartbeat_id: target.hb.id,
      next_fire_at: next.toISOString(),
    });
    return {
      ok: true,
      output: {
        heartbeat_id: target.hb.id,
        slug: target.hb.slug,
        next_fire_at: next.toISOString(),
      },
    };
  },
};

const heartbeat_update_state: BuiltinToolDef = {
  slug: 'heartbeat_update_state',
  name: "Update a heartbeat's state",
  description:
    "JSON-merge a `patch` object into a heartbeat's `state` jsonb. Top-level keys overwrite same-named keys in the existing state; other keys are preserved. Set a key to null to remove it. Pass `slug` to target a specific heartbeat — required from a regular responder turn (look at the 'Open heartbeats' block in your system prompt to find which slug to use); optional inside a heartbeat fire (firing one is the default). Use this to track progress (e.g. {answered: ['family'], expecting_reply: false}) so the next fire knows where the skill left off.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'Heartbeat slug whose state to update. Required when reacting to a user reply (responder turn). Inside a fire, omit to default to the firing one.',
      },
      patch: {
        type: 'object',
        description:
          'Object to merge into state. Top-level keys overwrite; nested objects are NOT deep-merged.',
      },
    },
    required: ['patch'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
      ctx.step?.setMeta({ branch: 'bad_patch_shape' });
      return { ok: false, error: 'patch must be a plain object' };
    }
    const target = await resolveTargetHeartbeat(input, ctx.ownerId);
    if (!target.ok) {
      ctx.step?.setMeta({ branch: 'no_target', error: target.error });
      return { ok: false, error: target.error };
    }
    // Apply patch: drop null-valued keys, overwrite the rest.
    const existing = (target.hb.state ?? {}) as Record<string, unknown>;
    const patch = input.patch as Record<string, unknown>;
    const next: Record<string, unknown> = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    // The state is part of the fire's prompt: another heartbeat's state set
    // by a login other than the brain owner makes that heartbeat this
    // login's (W7a fix round 3, heartbeats.created_by), so the tick fires it
    // as this login, never as the anchor.
    const login = target.via === 'slug' ? (currentWorkspaceScope()?.loginId ?? null) : null;
    const maker = login && login !== ctx.ownerId ? { createdBy: login } : {};
    await heartbeatRow(() =>
      db
        .update(heartbeats)
        .set({ state: next, updatedAt: new Date(), ...maker })
        .where(and(eq(heartbeats.id, target.hb.id), eq(heartbeats.ownerId, ctx.ownerId))),
    );
    ctx.step?.setMeta({
      branch: 'updated',
      via: target.via,
      heartbeat_id: target.hb.id,
      patched_keys: Object.keys(patch),
    });
    return { ok: true, output: { heartbeat_id: target.hb.id, slug: target.hb.slug, state: next } };
  },
};

/** Default cap on heartbeat_list output. The full state jsonb can
 *  be sizable for skills that accumulate (interview answers, daily
 *  log entries, …) — multiplied by N rows it'd blow context.
 *  P2-3 from the v1 audit. */
const HEARTBEAT_LIST_DEFAULT_LIMIT = 20;
const HEARTBEAT_LIST_MAX_LIMIT = 100;

const heartbeat_list: BuiltinToolDef = {
  slug: 'heartbeat_list',
  name: 'List the user heartbeats',
  description:
    "List the user's heartbeats with status, schedule, agent/skill slugs, and next-fire time. By default returns up to 20 rows with a SLIM projection (no state jsonb) — that's enough for the user-facing question 'what are you tracking for me?'. Pass `include_state: true` to get each heartbeat's full state (useful when the model needs to reason about progress). Pass `limit` to override (max 100). Pass `status` to filter.",
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'paused', 'completed', 'cancelled'],
        description: 'Filter to a single status. Omit for all.',
      },
      limit: {
        type: 'number',
        description: `Max rows to return. Default ${HEARTBEAT_LIST_DEFAULT_LIMIT}, hard cap ${HEARTBEAT_LIST_MAX_LIMIT}.`,
      },
      include_state: {
        type: 'boolean',
        description:
          "Include each heartbeat's full state jsonb. Off by default to keep the LLM's context lean — flip on when reasoning about progress / answered topics / etc.",
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const status = typeof input.status === 'string' ? input.status : null;
    const includeState = input.include_state === true;
    let limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
        ? Math.floor(input.limit)
        : HEARTBEAT_LIST_DEFAULT_LIMIT;
    if (limit > HEARTBEAT_LIST_MAX_LIMIT) limit = HEARTBEAT_LIST_MAX_LIMIT;

    // Project the column set based on include_state. Saves bytes
    // on the wire AND in the LLM tool_result. Always include the
    // identity + status + scheduling fields — those are tiny and
    // useful regardless.
    const baseColumns = {
      id: heartbeats.id,
      slug: heartbeats.slug,
      name: heartbeats.name,
      description: heartbeats.description,
      agentSlug: heartbeats.agentSlug,
      skillSlug: heartbeats.skillSlug,
      status: heartbeats.status,
      scheduleKind: heartbeats.scheduleKind,
      nextFireAt: heartbeats.nextFireAt,
      lastFiredAt: heartbeats.lastFiredAt,
      fireCount: heartbeats.fireCount,
    };
    // A heartbeat's state is its maker's only (W7 integration fix 2, H1):
    // the caller reads the state of the heartbeats it set up, never another
    // login's (the anchor's included).
    const columns = includeState
      ? { ...baseColumns, state: heartbeats.state, createdBy: heartbeats.createdBy }
      : baseColumns;

    const baseQuery = db.select(columns).from(heartbeats);
    const rows = status
      ? await baseQuery
          .where(
            and(
              eq(heartbeats.ownerId, ctx.ownerId),
              eq(heartbeats.status, status as 'active' | 'paused' | 'completed' | 'cancelled'),
            ),
          )
          .limit(limit)
      : await baseQuery.where(eq(heartbeats.ownerId, ctx.ownerId)).limit(limit);

    const me = callerLogin(ctx);
    const shown = includeState
      ? rows.map((r) => {
          const { createdBy, ...rest } = r as typeof r & { createdBy: string | null };
          const maker = createdBy && createdBy !== ctx.ownerId ? createdBy : null;
          return maker === me ? rest : { ...rest, state: null, state_hidden: true };
        })
      : rows;
    ctx.step?.setMeta({
      count: rows.length,
      limit,
      include_state: includeState,
      ...(status ? { status_filter: status } : {}),
    });
    return {
      ok: true,
      output: {
        heartbeats: shown,
        count: rows.length,
        limit,
        truncated: rows.length === limit,
      },
    };
  },
};

const heartbeat_fire: BuiltinToolDef = {
  slug: 'heartbeat_fire',
  name: 'Force-fire a heartbeat now',
  description:
    "Fire the heartbeat with the given slug RIGHT NOW, bypassing all gates (idle / quiet hours / cooldown). Used by the operator's 'Fire now' button and by skills that want to chain into another heartbeat. The fire still records to traces + heartbeat_fires with disposition='fired'. Does NOT need to be inside an existing heartbeat fire. Cannot fire the heartbeat that is currently calling this tool (direct self-recursion is refused), and chained fires are capped at MAX_HEARTBEAT_DEPTH to prevent runaway loops.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'The heartbeat slug to fire.' },
    },
    required: ['slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = typeof input.slug === 'string' ? input.slug : '';
    if (!slug) {
      ctx.step?.setMeta({ branch: 'missing_slug' });
      return { ok: false, error: 'slug required' };
    }

    // P1-3: recursion guards.
    // (1) Direct self-recursion: if we're currently inside a fire
    //     for the SAME slug, refuse with a clear error. This is the
    //     pathological "skill calls heartbeat_fire(own_slug) every
    //     fire" loop — would spin until OpenRouter budget exhausted.
    // (2) Depth cap: even chained fires (A→B→C) get capped at
    //     MAX_HEARTBEAT_DEPTH (3). Mirrors MAX_AGENT_DEPTH for the
    //     invoke_agent delegation chain — same "enough for real
    //     compositions, not enough for runaway" rationale.
    const parent = currentHeartbeat();
    if (parent && parent.slug === slug) {
      ctx.step?.setMeta({ branch: 'self_recursion', parent_slug: parent.slug });
      return {
        ok: false,
        error: `refusing to recursively heartbeat_fire('${slug}') — that is the heartbeat currently firing. If you need to defer re-asking, use heartbeat_snooze.`,
      };
    }
    if (parent && parent.depth >= MAX_HEARTBEAT_DEPTH) {
      ctx.step?.setMeta({
        branch: 'depth_exceeded',
        depth: parent.depth,
        max: MAX_HEARTBEAT_DEPTH,
      });
      return {
        ok: false,
        error: `chained heartbeat_fire depth ${parent.depth} would exceed MAX_HEARTBEAT_DEPTH (${MAX_HEARTBEAT_DEPTH}). Trim the chain.`,
      };
    }

    // In a workspace scope (W7a fix round 2, N1) the tool runs in its
    // caller's scope (it is not an AREA_SYSTEM_TOOLS tool): the heartbeat row
    // is read on the system pool after the assistants area check, and so is
    // the fire's own bookkeeping (its agent, skill, key, trace and fire log),
    // while the fire's tool resolution and turn run back in the caller's
    // scope: a second Admin login's fire answers that login, with its
    // rights, never the anchor's.
    const caller = currentWorkspaceScope();
    const hb = caller
      ? await areaSystem('assistants', () => loadOwnedHeartbeatBySlug(ctx.ownerId, slug))
      : await loadOwnedHeartbeatBySlug(ctx.ownerId, slug);
    if (!hb) return { ok: false, error: `heartbeat '${slug}' not found` };
    if (hb.status !== 'active') {
      return { ok: false, error: `heartbeat '${slug}' is '${hb.status}', not 'active'` };
    }
    // The fire answers its firer (W7 integration fix 2, H1), the anchor
    // included: its reply, state and trace are the firer's to read.
    const writes = currentRequestMode()?.writes === true;
    const answeredBy = callerLogin(ctx);
    const result = caller
      ? await areaSystem('assistants', () =>
          forceFire(hb, {
            inCaller: (fn) => withTurnScope(caller, fn, { writes }),
            answeredBy,
          }),
        )
      : await forceFire(hb, { answeredBy });
    ctx.step?.setMeta({
      branch: 'fired',
      heartbeat_id: hb.id,
      disposition: result.disposition,
      parent_depth: parent?.depth ?? null,
    });
    return { ok: true, output: { slug, disposition: result.disposition, reply: result.replyText } };
  },
};

export const HEARTBEAT_TOOLS: readonly BuiltinToolDef[] = [
  heartbeat_complete,
  heartbeat_snooze,
  heartbeat_update_state,
  heartbeat_list,
  heartbeat_fire,
];

/**
 * The subset of HEARTBEAT_TOOLS that responder turns need access to
 * for the continuity flow (user replying to a heartbeat question
 * outside the fire context). P6: these are a per-turn AFFORDANCE —
 * the responders INJECT them into the model's tool list only when
 * `hasActiveHeartbeatsOnSurface` returns true, and never grant them as
 * stored tools (see server/web/lib/assistant.ts + server/api/src/main.ts).
 *
 * Explicitly excludes:
 *  - `heartbeat_list`  — operator/skill tool, useful any time
 *  - `heartbeat_fire`  — operator/skill tool, useful any time
 */
export const HEARTBEAT_RESPONDER_TOOLS: readonly string[] = [
  'heartbeat_update_state',
  'heartbeat_complete',
  'heartbeat_snooze',
];

/** Register the heartbeat-control tools with the @mantle/tools registry.
 *  Call once at boot from server/api (and any other process that
 *  resolves tools). Idempotent — registerBuiltin overwrites the existing
 *  entry if called twice. */
export function registerHeartbeatTools(): void {
  for (const def of HEARTBEAT_TOOLS) registerBuiltin(def);
}

// Suppress unused — computeNextFireAt is re-exported only for tests
// that want to assert schedule arithmetic without round-tripping fire.
void computeNextFireAt;
