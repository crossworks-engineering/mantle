/**
 * Backfill the location/geo capability onto an EXISTING brain.
 *
 * Fresh installs get this automatically: the manifest persona now grants the
 * `location` tool group and the `location_awareness` skill, and onboarding-
 * provision seeds the persona from the manifest. This script is the backfill for
 * brains provisioned before location landed.
 *
 * What it does (all idempotent, gap-fill — never clobbers operator edits):
 *   1. applyManifest(onlySkills:['location_awareness']) — seeds the `location`
 *      tool group, the Mapbox HTTP tools (mapbox_reverse_geocode/_search), the
 *      location_* builtins, and the location_awareness skill, and attaches that
 *      skill to the manifest persona.
 *   2. Grants the `location` tool GROUP to every enabled responder/assistant —
 *      applyManifest attaches persona SKILLS but not its tool GROUPS (the persona
 *      is provisioned separately), so the group grant is backfilled here.
 *
 * The Mapbox tools stay dormant until a `mapbox` key is added under
 * Settings → API keys. See docs/remote-db-dev.md + docs/api-console.md.
 *
 * Usage:  pnpm -C apps/web seed:location           (resolves the sole owner)
 *         ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:location
 */

import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { db, agents } from '@mantle/db';
import { sql } from 'drizzle-orm';
import { applyManifest } from '../lib/system-manifest/seed';

const LOCATION_GROUP = 'location';
const LOCATION_SKILL = 'location_awareness';

export async function seedLocation(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: [], onlySkills: [LOCATION_SKILL], mode: 'gap-fill' });

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

  let granted = 0;
  for (const a of responders) {
    const cur = a.groups ?? [];
    if (cur.includes(LOCATION_GROUP)) continue;
    await db
      .update(agents)
      .set({ toolGroupSlugs: [...cur, LOCATION_GROUP], updatedAt: new Date() })
      .where(eq(agents.id, a.id));
    granted += 1;
    console.log(`[location] granted '${LOCATION_GROUP}' group to agent '${a.slug}'`);
  }
  console.log(
    `[location] done — '${LOCATION_GROUP}' group granted to ${granted} responder/assistant agent(s); ` +
      `skill '${LOCATION_SKILL}' + Mapbox tools seeded (dormant until a 'mapbox' key is added).`,
  );
}

async function resolveOwnerId(): Promise<string> {
  const fromEnv = process.env.ALLOWED_USER_ID?.trim();
  if (fromEnv) return fromEnv;
  // Single-user system: resolve the sole auth.users row (mirrors the workers).
  const res = (await db.execute(sql`select id from auth.users limit 2`)) as unknown;
  const list = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
    id: string;
  }[];
  if (list.length === 1) return list[0]!.id;
  throw new Error(
    'Could not resolve owner: set ALLOWED_USER_ID (auth.users has 0 or >1 rows).',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  resolveOwnerId()
    .then((ownerId) => seedLocation(ownerId))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed:location] failed:', err);
      process.exit(1);
    });
}
