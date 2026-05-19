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
 * Context rules:
 *   - heartbeat_complete / heartbeat_snooze / heartbeat_update_state
 *     all refuse cleanly when there is no current heartbeat context.
 *     This prevents an agent from accidentally completing a heartbeat
 *     from a regular turn (which would be a confusing bug).
 *   - heartbeat_list takes no args and reads all heartbeats.
 *   - heartbeat_fire takes a slug and force-fires that heartbeat
 *     (bypassing gates). Useful for testing and for skills that
 *     chain heartbeats.
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

function requireContext(): { heartbeatId: string; ownerId: string } | null {
  return currentHeartbeat();
}

async function loadOwnedHeartbeat(ownerId: string, id: string): Promise<Heartbeat | null> {
  const [row] = await db
    .select()
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, ownerId), eq(heartbeats.id, id)))
    .limit(1);
  return row ?? null;
}

const heartbeat_complete: BuiltinToolDef = {
  slug: 'heartbeat_complete',
  name: 'Mark the current heartbeat complete',
  description:
    'Permanently stop the heartbeat that is currently firing. Use this when the skill has accomplished what it set out to do (e.g. all interview questions answered). Takes an optional `reason` string that is stored on the heartbeat row for the operator to see later. After this call, the heartbeat will never fire again unless the operator manually re-activates it. ONLY callable from inside a heartbeat fire.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          "Short free-text explanation of why the heartbeat is being completed, e.g. 'all topics covered' or 'user asked to stop'.",
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const c = requireContext();
    if (!c) {
      return {
        ok: false,
        error:
          'heartbeat_complete is only callable from inside a heartbeat fire; no current heartbeat context found.',
      };
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
      .where(and(eq(heartbeats.id, c.heartbeatId), eq(heartbeats.ownerId, ctx.ownerId)));
    ctx.step?.setMeta({ heartbeat_id: c.heartbeatId, reason });
    return { ok: true, output: { heartbeat_id: c.heartbeatId, status: 'completed', reason } };
  },
};

const heartbeat_snooze: BuiltinToolDef = {
  slug: 'heartbeat_snooze',
  name: 'Snooze the current heartbeat',
  description:
    "Push the current heartbeat's next fire forward without completing it. Either pass `for_hours` (e.g. 24 = try again tomorrow) or `until` (an ISO-8601 timestamp). Useful when the user is busy or the moment isn't right but the heartbeat should keep trying. ONLY callable from inside a heartbeat fire.",
  inputSchema: {
    type: 'object',
    properties: {
      for_hours: { type: 'number', description: 'How many hours from now to defer.' },
      until: { type: 'string', description: 'ISO-8601 instant to defer until.' },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const c = requireContext();
    if (!c) {
      return {
        ok: false,
        error: 'heartbeat_snooze is only callable from inside a heartbeat fire.',
      };
    }
    let next: Date;
    if (typeof input.until === 'string') {
      const t = new Date(input.until);
      if (Number.isNaN(t.getTime())) return { ok: false, error: 'invalid until iso' };
      next = t;
    } else if (typeof input.for_hours === 'number' && input.for_hours > 0) {
      next = new Date(Date.now() + input.for_hours * 3600_000);
    } else {
      return { ok: false, error: 'pass either for_hours (>0) or until (ISO-8601)' };
    }
    await db
      .update(heartbeats)
      .set({ nextFireAt: next, updatedAt: new Date() })
      .where(and(eq(heartbeats.id, c.heartbeatId), eq(heartbeats.ownerId, ctx.ownerId)));
    ctx.step?.setMeta({ heartbeat_id: c.heartbeatId, next_fire_at: next.toISOString() });
    return { ok: true, output: { heartbeat_id: c.heartbeatId, next_fire_at: next.toISOString() } };
  },
};

const heartbeat_update_state: BuiltinToolDef = {
  slug: 'heartbeat_update_state',
  name: "Update the current heartbeat's state",
  description:
    "JSON-merge a patch object into the current heartbeat's `state` jsonb. Top-level keys in the patch overwrite same-named keys in the existing state; other keys are preserved. Set a key to null to remove it. Use this to track progress (e.g. {answered: ['family'], expecting_reply: false}) so the next fire knows where the skill left off. ONLY callable from inside a heartbeat fire.",
  inputSchema: {
    type: 'object',
    properties: {
      patch: {
        type: 'object',
        description: 'Object to merge into state. Top-level keys overwrite; nested objects are NOT deep-merged.',
      },
    },
    required: ['patch'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    // Diagnostic for the v1 "trace says success but DB didn't update"
    // mystery — each branch logs so the agent stdout tells us which
    // path the handler took. setMeta on every branch so /traces also
    // surfaces it without needing to re-run.
    const c = requireContext();
    if (!c) {
      const err = 'heartbeat_update_state called outside heartbeat fire context (currentHeartbeat()=null)';
      console.error(`[heartbeats:tool] ${err}`);
      ctx.step?.setMeta({ branch: 'no_context', error: err });
      return {
        ok: false,
        error: 'heartbeat_update_state is only callable from inside a heartbeat fire.',
      };
    }
    if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
      const err = `patch shape invalid: typeof=${typeof input.patch} isArray=${Array.isArray(input.patch)}`;
      console.error(`[heartbeats:tool] ${err}`);
      ctx.step?.setMeta({ branch: 'bad_patch_shape', error: err });
      return { ok: false, error: 'patch must be a plain object' };
    }
    const hb = await loadOwnedHeartbeat(ctx.ownerId, c.heartbeatId);
    if (!hb) {
      const err = `heartbeat row not found: id=${c.heartbeatId} owner=${ctx.ownerId}`;
      console.error(`[heartbeats:tool] ${err}`);
      ctx.step?.setMeta({ branch: 'hb_not_found', error: err });
      return { ok: false, error: 'heartbeat row not found (race?)' };
    }
    // Apply patch: drop null-valued keys, overwrite the rest.
    const existing = (hb.state ?? {}) as Record<string, unknown>;
    const patch = input.patch as Record<string, unknown>;
    const next: Record<string, unknown> = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const updateResult = await db
      .update(heartbeats)
      .set({ state: next, updatedAt: new Date() })
      .where(and(eq(heartbeats.id, c.heartbeatId), eq(heartbeats.ownerId, ctx.ownerId)))
      .returning({ id: heartbeats.id });
    const updatedCount = updateResult.length;
    console.error(
      `[heartbeats:tool] heartbeat_update_state OK id=${c.heartbeatId} ` +
        `patched=${Object.keys(patch).join(',')} updated_rows=${updatedCount}`,
    );
    ctx.step?.setMeta({
      branch: 'updated',
      heartbeat_id: c.heartbeatId,
      patched_keys: Object.keys(patch),
      updated_rows: updatedCount,
    });
    return { ok: true, output: { state: next, updated_rows: updatedCount } };
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
