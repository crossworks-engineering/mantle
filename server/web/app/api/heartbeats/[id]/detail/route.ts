import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getHeartbeat, listHeartbeatFires } from '@/lib/heartbeats';
import { formatInProfile, loadProfilePreferences } from '@mantle/content';

/**
 * The single-heartbeat "biography" bundle for /heartbeats/[id]: the summary,
 * the last 50 fires, and the dates pre-formatted in the owner's profile (so the
 * client doesn't need the server-only formatter). 404 if not owned.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const [heartbeat, fires, prefs] = await Promise.all([
    getHeartbeat(user.id, id),
    listHeartbeatFires(user.id, id, 50),
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
