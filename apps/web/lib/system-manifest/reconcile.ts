/**
 * Boot-time manifest reconcile — closes the "updated the image but never ran the
 * seed scripts" gap for self-hosters.
 *
 * An update is `docker compose pull && up -d` (the in-app updater runs exactly
 * that — it does NOT refresh docker-compose.yml). That re-seeds builtins on boot
 * but does NOT seed new HTTP tools, new skills, updated tool-GROUP membership, or
 * grant new default groups to the responder — so a new capability silently never
 * reaches an existing brain (we hit this shipping 0.28.0: route_map/mapbox_directions
 * were added to the `location` group but the live group stayed stale).
 *
 * This runs from apps/web/instrumentation.ts on web-server boot (carried IN the
 * image, so a stale compose file can't skip it), and brings an already-provisioned
 * brain in line with the manifest, once per version:
 *   1. seedToolCapabilities(overwrite) — sync HTTP tools + tool-group MEMBERSHIP
 *      (gap-fill, the onboarding mode, deliberately won't touch an existing group).
 *   2. applyManifest(only:[], gap-fill) — seed missing skills + attach the persona's
 *      skills. `only:[]` means NO specialist agents are created/overwritten (and so
 *      no OpenRouter key is required) — operator agent customisations are untouched.
 *   3. Union the manifest persona's default tool groups onto enabled responders —
 *      ADD only, never remove (see missingPersonaGroups).
 *
 * Safety: production-only, opt-out via MANTLE_DISABLE_BOOT_RECONCILE=1, skips a
 * fresh/unprovisioned brain (onboarding owns that), runs once per process and once
 * per APP_VERSION (a marker in profile prefs), and is fully best-effort — it can
 * NEVER throw into boot (a failure must not take the server down).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db, agents } from '@mantle/db';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import { APP_VERSION } from '@/lib/version';
import { applyManifest, seedToolCapabilities } from './seed';
import { PERSONA_TOOL_GROUP_SLUGS } from './manifest';
import { missingPersonaGroups } from './reconcile-util';

let ranThisProcess = false;

/** Single-owner system: prefer the configured id, else the sole auth.users row. */
async function resolveOwnerId(): Promise<string | null> {
  const fromEnv = process.env.ALLOWED_USER_ID?.trim();
  if (fromEnv) return fromEnv;
  const res = (await db.execute(sql`select id from auth.users limit 2`)) as unknown;
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
    id: string;
  }[];
  return rows.length === 1 ? (rows[0]!.id as string) : null;
}

/** Union the manifest persona's default groups onto every enabled responder. */
async function grantPersonaGroupsByRole(ownerId: string): Promise<string[]> {
  const responders = await db
    .select({ id: agents.id, slug: agents.slug, groups: agents.toolGroupSlugs })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, ['responder', 'assistant']),
      ),
    );
  const granted: string[] = [];
  for (const a of responders) {
    const missing = missingPersonaGroups(a.groups, PERSONA_TOOL_GROUP_SLUGS);
    if (missing.length === 0) continue;
    await db
      .update(agents)
      .set({ toolGroupSlugs: [...(a.groups ?? []), ...missing], updatedAt: new Date() })
      .where(eq(agents.id, a.id));
    granted.push(`${a.slug}:+${missing.join(',')}`);
  }
  return granted;
}

export async function reconcileManifestOnBoot(): Promise<void> {
  if (ranThisProcess) return;
  ranThisProcess = true;

  // Production update mechanism only — in dev you run `pnpm seed:*` by hand, and
  // dev may point at the prod DB (the tailnet workflow), which we must not mutate
  // on a `pnpm dev` boot.
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.MANTLE_DISABLE_BOOT_RECONCILE === '1') {
    console.log('[reconcile] disabled via MANTLE_DISABLE_BOOT_RECONCILE');
    return;
  }

  try {
    const ownerId = await resolveOwnerId();
    if (!ownerId) {
      console.log('[reconcile] no single owner — skipping (fresh/unprovisioned install)');
      return;
    }

    // Only reconcile an ALREADY-provisioned brain; onboarding seeds a fresh one.
    const [responder] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.ownerId, ownerId),
          eq(agents.enabled, true),
          inArray(agents.role, ['responder', 'assistant']),
        ),
      )
      .limit(1);
    if (!responder) {
      console.log('[reconcile] no provisioned responder — skipping (onboarding will seed)');
      return;
    }

    // Once per version: a normal restart on an already-synced brain is a no-op.
    const prefs = await loadProfilePreferences(ownerId);
    if (prefs.lastReconciledVersion === APP_VERSION) return;

    await seedToolCapabilities(ownerId, 'overwrite');
    await applyManifest(ownerId, { only: [], mode: 'gap-fill' });
    const granted = await grantPersonaGroupsByRole(ownerId);
    await updateProfilePreferences(ownerId, { lastReconciledVersion: APP_VERSION });

    console.log(
      `[reconcile] synced manifest to v${APP_VERSION}` +
        (granted.length ? `; granted ${granted.join('; ')}` : ' (grants already current)'),
    );
  } catch (err) {
    // Best-effort: a reconcile failure must never take the server down.
    console.error(
      '[reconcile] skipped (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}
