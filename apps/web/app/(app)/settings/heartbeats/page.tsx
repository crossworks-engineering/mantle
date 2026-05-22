import { asc, eq } from 'drizzle-orm';
import { db, agents, skills } from '@mantle/db';
import { formatInProfile, loadProfilePreferences } from '@mantle/content';
import { requireOwner } from '@/lib/auth';
import { listHeartbeats } from '@/lib/heartbeats';
import { SetPageTitle } from '@/components/layout/page-title';
import { HeartbeatsClient, type HeartbeatFormattedTimes } from './heartbeats-client';

/**
 * /settings/heartbeats — proactive Saskia control surface.
 *
 * Lists every heartbeat, surfaces status badges, and embeds a form
 * for create/edit. The "Fire now" button bypasses gates — useful
 * for testing. Status toggles (Pause / Resume) and Delete are
 * inline.
 *
 * The page loads the agent + skill catalogues server-side so the
 * form's selectors don't need a client-side fetch.
 */
export default async function HeartbeatsPage() {
  const user = await requireOwner();
  const [rows, agentRows, skillRows, prefs] = await Promise.all([
    listHeartbeats(user.id),
    db
      .select({ slug: agents.slug, name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.ownerId, user.id))
      .orderBy(asc(agents.slug)),
    db
      .select({ slug: skills.slug, name: skills.name, defaultState: skills.defaultState })
      .from(skills)
      .where(eq(skills.ownerId, user.id))
      .orderBy(asc(skills.slug)),
    loadProfilePreferences(user.id),
  ]);

  // Pre-format dates server-side using the user's profile tz + locale.
  // Critical: doing this on the client via toLocaleString() produces a
  // different string than the Node SSR pass (different tz / locale
  // defaults), which trips React's hydration check. Same pattern the
  // detail page uses.
  const formatted: HeartbeatFormattedTimes = {};
  for (const h of rows) {
    formatted[h.id] = {
      nextFireAt: h.nextFireAt ? formatInProfile(new Date(h.nextFireAt), prefs) : null,
    };
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Heartbeats" />
      <HeartbeatsClient
        initial={rows}
        agents={agentRows}
        skills={skillRows.map((s) => ({
          slug: s.slug,
          name: s.name,
          // jsonb may surface as `unknown`; normalize to a record so
          // the client-side form's pre-fill code doesn't have to.
          defaultState: (s.defaultState ?? {}) as Record<string, unknown>,
        }))}
        formatted={formatted}
      />
    </div>
  );
}
