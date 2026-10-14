import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { toolMakerFor } from '@/lib/tools';
import { getHeartbeat, listHeartbeatFires } from '@/lib/heartbeats';
import { formatInProfile, loadProfilePreferences } from '@mantle/content';

/**
 * The single-heartbeat "biography" bundle for /heartbeats/[id]: the summary,
 * the last 50 fires, and the dates pre-formatted in the owner's profile (so the
 * client doesn't need the server-only formatter). 404 if not owned. A
 * fire's reply text, state before and after and trace are the login's it
 * answered only (null to others, the anchor included); the heartbeat's
 * state is its maker's only (W7 integration fix 2).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const [heartbeat, fires, prefs] = await Promise.all([
    getHeartbeat(user.id, id, toolMakerFor(user)),
    // A fire's reply goes to the login it answered only.
    listHeartbeatFires(user.id, id, toolMakerFor(user), 50),
    loadProfilePreferences(user.id),
  ]);
  if (!heartbeat) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });

  const fmt = (iso: string | null) => (iso ? formatInProfile(new Date(iso), prefs) : '—');
  return NextResponse.json({
    heartbeat,
    fires,
    labels: {
      nextFireAt: fmt(heartbeat.nextFireAt),
      lastFiredAt: fmt(heartbeat.lastFiredAt),
      fires: Object.fromEntries(fires.map((f) => [f.id, fmt(f.firedAt)])),
    },
  });
}
