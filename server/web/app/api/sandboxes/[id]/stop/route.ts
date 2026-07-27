import { NextResponse } from '@/server/http-compat';
import { getSandboxByRef, setSandboxStatus } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { sandboxdStop } from '@/lib/sandboxd';

/**
 * POST /api/sandboxes/:id/stop — the UI's `sandbox_stop`: stop the container
 * to free memory/CPU. Installed packages and /files are kept; the next
 * `sandbox_exec` restarts it. The row is only marked stopped when sandboxd
 * confirms — a failed stop must not make the registry lie about a container
 * that is still running.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const row = await getSandboxByRef(user.id, id);
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
