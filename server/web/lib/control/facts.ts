/**
 * The subject box's `facts` case (phase 3, the fleet matrix,
 * docs/control-center.md): what the Control Center shows of this box, read
 * only. A case on the signed route like the others (box.ts), so the same
 * two checks hold it and no agent, MCP client or API key on the box
 * reaches it.
 *
 * Numbers, settings and model ids only: box_status's own numbers (schema 1,
 * the same 30-second collection as the Status screen), the company sign-in
 * mode, each agent's and AI worker's slug, provider and model, two counts
 * and the last backup's time and outcome. Never a name a person wrote, a
 * prompt, a key, a login's email or any user data.
 */
import { loadBackupStatus } from '@mantle/content';
import { agents, aiWorkers, apps, asc, db, sql, workspaces } from '@mantle/db';
import type { ControlFacts } from '@mantle/db/schema';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { oidcSettings } from '@/lib/oidc/settings';

/** The most agent and worker rows one answer carries. */
export const FACTS_MAX_ROWS = 500;

/** This box's facts. `ownerId` is the brain's anchor (the control actor's
 *  id). A part that fails is left out (null status, null backup), so one
 *  slow probe never hides the rest. */
export async function collectFacts(ownerId: string): Promise<ControlFacts> {
  const [status, agentRows, workerRows, counts, backup] = await Promise.all([
    readStatus(ownerId),
    db
      .select({
        slug: agents.slug,
        role: agents.role,
        provider: agents.provider,
        model: agents.model,
        enabled: agents.enabled,
        assigned: sql<boolean>`${agents.assignedUserId} is not null`,
      })
      .from(agents)
      .orderBy(asc(agents.slug))
      .limit(FACTS_MAX_ROWS),
    db
      .select({
        slug: aiWorkers.slug,
        kind: aiWorkers.kind,
        provider: aiWorkers.provider,
        model: aiWorkers.model,
        enabled: aiWorkers.enabled,
      })
      .from(aiWorkers)
      .orderBy(asc(aiWorkers.slug))
      .limit(FACTS_MAX_ROWS),
    db
      .select({
        workspaces: sql<number>`(select count(*)::int from ${workspaces})`,
        apps: sql<number>`(select count(*)::int from ${apps})`,
      })
      .from(sql`(select 1) as one`),
    loadBackupStatus(ownerId).catch(() => null),
  ]);
  return {
    schema: 1,
    at: new Date().toISOString(),
    status,
    signIn: oidcSettings().mode,
    agents: agentRows.map((a) => ({ ...a, role: String(a.role), assigned: a.assigned === true })),
    workers: workerRows.map((w) => ({ ...w, kind: String(w.kind) })),
    counts: { workspaces: counts[0]?.workspaces ?? 0, apps: counts[0]?.apps ?? 0 },
    backup: backup
      ? { lastRunAt: backup.lastRunAt, ok: backup.ok, lastSuccessAt: backup.lastSuccessAt ?? null }
      : null,
  };
}

/** box_status's numbers (lazily loaded: the collectors live in the web
 *  process), or null. */
async function readStatus(ownerId: string): Promise<ControlFacts['status']> {
  try {
    const [{ boxStatus }, { shapeBoxStatus }] = await Promise.all([
      import('@/lib/box-status'),
      import('@mantle/tools/box-status'),
    ]);
    return shapeBoxStatus(await boxStatus(ownerId));
  } catch (err) {
    log('control').warn('facts: no box status:', errorMessage(err));
    return null;
  }
}
