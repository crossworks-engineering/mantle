/**
 * Heartbeat tick loop. apps/agent calls `tickHeartbeats(ownerId)` on
 * a per-minute setInterval (mirrors the reflector pattern). Each
 * tick selects up to BATCH due heartbeats and fires them
 * sequentially — heartbeats talk to users, so parallelism risks
 * collision (Saskia sending two messages back-to-back from different
 * fires reads as broken).
 *
 * Each fire is gated and self-rescheduling — see fire.ts. The tick
 * is just the "find what's due, dispatch" outer loop.
 */

import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { db, heartbeats } from '@mantle/db';
import { tickFire } from './fire';
import { isFireInflight } from './inflight';

const TICK_BATCH = 10;

export type TickReport = {
  considered: number;
  fired: number;
  skipped: number;
  errored: number;
};

export async function tickHeartbeats(ownerId: string, now: Date = new Date()): Promise<TickReport> {
  const dueAll = await db
    .select()
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.ownerId, ownerId),
        eq(heartbeats.status, 'active'),
        isNotNull(heartbeats.nextFireAt),
        lte(heartbeats.nextFireAt, now),
      ),
    )
    .orderBy(asc(heartbeats.nextFireAt))
    .limit(TICK_BATCH);

  // P0-2: filter out heartbeats whose previous fire is still
  // running. The fire updates next_fire_at only after the LLM
  // round-trip completes (can take 30-90s), so a fire taking
  // longer than the 60s tick interval would otherwise be
  // re-selected and double-fire. Counts as a skip — we'll
  // re-consider it next tick when the in-flight one finishes.
  const due = dueAll.filter((hb) => !isFireInflight(hb.id));

  const report: TickReport = { considered: due.length, fired: 0, skipped: 0, errored: 0 };
  for (const hb of due) {
    try {
      const r = await tickFire(hb);
      if (r.disposition === 'fired' || r.disposition === 'completed') report.fired++;
      else if (
        r.disposition === 'error' ||
        r.disposition === 'auto_paused' ||
        r.disposition === 'fired_undelivered'
      )
        report.errored++;
      else report.skipped++;
    } catch (err) {
      report.errored++;
      console.error(
        `[heartbeats] tick error for ${hb.slug}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return report;
}

/**
 * Read open heartbeats for a surface that are currently waiting on a
 * user reply (state.expecting_reply truthy). The responder calls this
 * each turn so it can inject "you have an open heartbeat" context into
 * the system prompt — keeps conversation continuity when the user
 * answers a heartbeat-asked question outside the heartbeat's own fire.
 *
 * Distinct from `hasActiveHeartbeatsOnSurface` below: this is the
 * narrower "expecting a reply RIGHT NOW" set (used for awareness-block
 * injection); the other is the broader "any active heartbeat on this
 * surface at all" set (used for tool-list exclusion). A heartbeat
 * between fires has expecting_reply=false but should still allow the
 * model to call heartbeat_complete if the user says "stop asking me".
 */
export async function openHeartbeatsForSurface(
  ownerId: string,
  surface: { kind: 'telegram'; chatId: string } | { kind: 'web' },
): Promise<Array<{ slug: string; name: string; state: Record<string, unknown> }>> {
  const rows = await db
    .select({
      slug: heartbeats.slug,
      name: heartbeats.name,
      state: heartbeats.state,
      surface: heartbeats.surface,
    })
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, ownerId), eq(heartbeats.status, 'active')));

  return rows
    .filter((r) => {
      // Only consider heartbeats whose state.expecting_reply is truthy
      // AND whose surface matches.
      const s = (r.state ?? {}) as Record<string, unknown>;
      if (!s.expecting_reply) return false;
      if (r.surface.kind !== surface.kind) return false;
      if (surface.kind === 'telegram' && r.surface.kind === 'telegram') {
        return r.surface.chat_id === surface.chatId;
      }
      return true; // web has no per-instance discriminator yet
    })
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      state: (r.state ?? {}) as Record<string, unknown>,
    }));
}

/**
 * Cheap boolean check: are there any active heartbeats on this surface
 * (regardless of expecting_reply)? Powers the per-turn tool-list
 * exclusion in the responders — when this returns false, the 3
 * responder-continuity tools (HEARTBEAT_RESPONDER_TOOLS in tools.ts)
 * are dropped from the model's tool list for the turn. The operator's
 * grant in agents.tool_slugs stays canonical; this is pure runtime
 * affordance hygiene.
 *
 * Returns true when there's ≥1 active heartbeat on the surface — that
 * covers both expecting_reply=true (the model might need to update
 * state) and expecting_reply=false (the model might need to honour
 * "stop asking me" by calling heartbeat_complete with the slug).
 */
export async function hasActiveHeartbeatsOnSurface(
  ownerId: string,
  surface: { kind: 'telegram'; chatId: string } | { kind: 'web' },
): Promise<boolean> {
  // Same surface-aware filter as openHeartbeatsForSurface, but we
  // short-circuit as soon as we see one match. Could be a COUNT
  // query but the row count is tiny (single-user, ≤dozens of active
  // heartbeats) — fetching surface jsonb + matching client-side is
  // simpler than encoding the jsonb match in SQL.
  const rows = await db
    .select({ surface: heartbeats.surface })
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, ownerId), eq(heartbeats.status, 'active')));

  for (const r of rows) {
    if (r.surface.kind !== surface.kind) continue;
    if (surface.kind === 'telegram' && r.surface.kind === 'telegram') {
      if (r.surface.chat_id === surface.chatId) return true;
    } else {
      return true; // web surface match
    }
  }
  return false;
}
