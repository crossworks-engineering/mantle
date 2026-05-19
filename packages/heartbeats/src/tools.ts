/**
 * The 5 heartbeat-control builtins. Live in @mantle/heartbeats rather
 * than @mantle/tools because they need the AsyncLocalStorage context
 * and the fire orchestrator — depending on those from @mantle/tools
 * would invert the dependency graph (heartbeats already depends on
 * tools, not the other way round).
 *
 * Registration: call `registerHeartbeatTools()` from apps/agent (and
 * apps/web's runtime if web ever fires heartbeats) at boot, BEFORE
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
import { db, heartbeats, type Heartbeat } from '@mantle/db';
import {
  registerBuiltin,
  type BuiltinToolDef,
  type ToolHandlerResult,
} from '@mantle/tools';
import { currentHeartbeat } from './context';
import { forceFire } from './fire';
import { computeNextFireAt } from './schedule';

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
): Promise<
  | { ok: true; hb: Heartbeat; via: 'slug' | 'als' }
  | { ok: false; error: string }
> {
  const slugInput = typeof input.slug === 'string' && input.slug.trim() ? input.slug.trim() : null;
  if (slugInput) {
    const hb = await loadOwnedHeartbeatBySlug(ownerId, slugInput);
    if (!hb) return { ok: false, error: `heartbeat '${slugInput}' not found for this owner` };
    return { ok: true, hb, via: 'slug' };
  }
  const ctx = currentHeartbeat();
  if (ctx) {
    const hb = await loadOwnedHeartbeatById(ownerId, ctx.heartbeatId);
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
    "Permanently stop a heartbeat. Use this when the skill has accomplished what it set out to do (e.g. all interview questions answered) OR when the user explicitly asks you to stop. Pass `slug` to target a specific heartbeat — required when called from a regular responder turn; optional inside a heartbeat fire (the firing one is the default). After this call, the heartbeat never fires again unless an operator re-activates it. Takes an optional `reason` string stored on the row for the operator to see.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          "Heartbeat slug to complete. Required when not inside a heartbeat fire. Inside a fire, omit to default to the firing heartbeat.",
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
    await db
      .update(heartbeats)
      .set({
        status: 'completed',
        completionReason: `tool_call:${reason}`,
        nextFireAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeats.id, target.hb.id), eq(heartbeats.ownerId, ctx.ownerId)));
    ctx.step?.setMeta({ branch: 'completed', via: target.via, heartbeat_id: target.hb.id, reason });
    return { ok: true, output: { heartbeat_id: target.hb.id, slug: target.hb.slug, status: 'completed', reason } };
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
        description:
          "Heartbeat slug to snooze. Required when not inside a heartbeat fire.",
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
    await db
      .update(heartbeats)
      .set({ nextFireAt: next, updatedAt: new Date() })
      .where(and(eq(heartbeats.id, target.hb.id), eq(heartbeats.ownerId, ctx.ownerId)));
    ctx.step?.setMeta({
      branch: 'snoozed',
      via: target.via,
      heartbeat_id: target.hb.id,
      next_fire_at: next.toISOString(),
    });
    return { ok: true, output: { heartbeat_id: target.hb.id, slug: target.hb.slug, next_fire_at: next.toISOString() } };
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
          "Heartbeat slug whose state to update. Required when reacting to a user reply (responder turn). Inside a fire, omit to default to the firing one.",
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
    await db
      .update(heartbeats)
      .set({ state: next, updatedAt: new Date() })
      .where(and(eq(heartbeats.id, target.hb.id), eq(heartbeats.ownerId, ctx.ownerId)));
    ctx.step?.setMeta({
      branch: 'updated',
      via: target.via,
      heartbeat_id: target.hb.id,
      patched_keys: Object.keys(patch),
    });
    return { ok: true, output: { heartbeat_id: target.hb.id, slug: target.hb.slug, state: next } };
  },
};

const heartbeat_list: BuiltinToolDef = {
  slug: 'heartbeat_list',
  name: 'List the user heartbeats',
  description:
    "List all of the user's heartbeats with their status, schedule, current state, and next fire time. Useful when the user asks 'what are you keeping track of for me?' or when deciding whether to spawn a related heartbeat. Returns full rows.",
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'paused', 'completed', 'cancelled'],
        description: 'Filter to a single status. Omit for all.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const status = typeof input.status === 'string' ? input.status : null;
    const rows = status
      ? await db
          .select()
          .from(heartbeats)
          .where(
            and(
              eq(heartbeats.ownerId, ctx.ownerId),
              eq(heartbeats.status, status as 'active' | 'paused' | 'completed' | 'cancelled'),
            ),
          )
      : await db.select().from(heartbeats).where(eq(heartbeats.ownerId, ctx.ownerId));
    ctx.step?.setMeta({ count: rows.length });
    return { ok: true, output: { heartbeats: rows, count: rows.length } };
  },
};

const heartbeat_fire: BuiltinToolDef = {
  slug: 'heartbeat_fire',
  name: 'Force-fire a heartbeat now',
  description:
    "Fire the heartbeat with the given slug RIGHT NOW, bypassing all gates (idle / quiet hours / cooldown). Used by the operator's 'Fire now' button and by skills that want to chain into another heartbeat. The fire still records to traces + heartbeat_fires with disposition='fired'. Does NOT need to be inside an existing heartbeat fire.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'The heartbeat slug to fire.' },
    },
    required: ['slug'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const slug = typeof input.slug === 'string' ? input.slug : '';
    if (!slug) return { ok: false, error: 'slug required' };
    const [hb] = await db
      .select()
      .from(heartbeats)
      .where(and(eq(heartbeats.ownerId, ctx.ownerId), eq(heartbeats.slug, slug)))
      .limit(1);
    if (!hb) return { ok: false, error: `heartbeat '${slug}' not found` };
    if (hb.status !== 'active') {
      return { ok: false, error: `heartbeat '${slug}' is '${hb.status}', not 'active'` };
    }
    const result = await forceFire(hb);
    ctx.step?.setMeta({ heartbeat_id: hb.id, disposition: result.disposition });
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

/** Register the heartbeat-control tools with the @mantle/tools registry.
 *  Call once at boot from apps/agent (and any other process that
 *  resolves tools). Idempotent — registerBuiltin overwrites the existing
 *  entry if called twice. */
export function registerHeartbeatTools(): void {
  for (const def of HEARTBEAT_TOOLS) registerBuiltin(def);
}

// Suppress unused — computeNextFireAt is re-exported only for tests
// that want to assert schedule arithmetic without round-tripping fire.
void computeNextFireAt;
