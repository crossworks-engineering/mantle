import { NextResponse } from '@/server/http-compat';
import { listSandboxes } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { sandboxdEnabled, sandboxdList } from '@/lib/sandboxd';

/**
 * GET /api/sandboxes — the Sandboxes surface's list payload (owner-scoped).
 * DB rows merged with sandboxd's live container state — live state wins for
 * status (idle-stop can stop a sandbox between execs; the row alone would
 * lie), the same merge `sandbox_list` does in the tool layer. sandboxd down
 * or absent → rows as-is, `disk: null`.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const rows = await listSandboxes(user.id);
  const live = await sandboxdList();
  const liveState = new Map<string, string>();
  if (live) {
    for (const s of live.sandboxes) {
      if (s.id && s.state) liveState.set(s.id, s.state === 'running' ? 'running' : 'stopped');
    }
  }

  return NextResponse.json({
    enabled: sandboxdEnabled(),
    disk: live?.disk ?? null,
    sandboxes: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      image: r.image,
      network: r.network,
      status: liveState.get(r.id) ?? r.status,
      lastUsedAt: r.lastUsedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
