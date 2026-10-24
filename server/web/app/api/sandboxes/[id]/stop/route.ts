import { NextResponse } from '@/server/http-compat';
import { setSandboxStatus } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { sandboxForLogin, sandboxdStop } from '@/lib/sandboxd';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/**
 * POST /api/sandboxes/:id/stop — the UI's `sandbox_stop`: stop the container
 * to free memory/CPU. Installed packages and /files are kept; the next
 * `sandbox_exec` restarts it. The row is only marked stopped when sandboxd
 * confirms — a failed stop must not make the registry lie about a container
 * that is still running.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const row = await sandboxForLogin(user, id);
  if (!row) return NextResponse.json({ error: 'sandbox not found' }, { status: 404 });

  const ok = await sandboxdStop(row.id);
  if (!ok) {
    return NextResponse.json(
      { error: 'sandboxd is unreachable — the sandbox was not stopped. Try again shortly.' },
      { status: 502 },
    );
  }
  await setSandboxStatus(row.id, 'stopped');
  return NextResponse.json({ ok: true, status: 'stopped' });
}
