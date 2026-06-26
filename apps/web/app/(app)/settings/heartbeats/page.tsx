import { formatInProfile, loadProfilePreferences } from '@mantle/content';
import { requireOwner } from '@/lib/auth';
import { listHeartbeats } from '@/lib/heartbeats';
import { listAgentOptions } from '@/lib/agents';
import { listSkills } from '@/lib/skills';
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
    listAgentOptions(user.id),
    listSkills(user.id),
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
    <>
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
    </>
  );
}
