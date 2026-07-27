import { NextResponse } from '@/server/http-compat';
import { and, desc, sql } from 'drizzle-orm';
import { db, traceSteps } from '@mantle/db';
import { deleteSandboxRow, getSandboxByRef } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { sandboxdList, sandboxdRm } from '@/lib/sandboxd';

/**
 * GET /api/sandboxes/:id — one sandbox (owner-scoped, live status merged) plus
 * its recent command history. Commands are the `sandbox_exec` trace steps for
 * this sandbox — the tool layer stamps `meta.sandboxId`/`command`/`exitCode`/
 * `timedOut`/`durationMs` on every exec step, so the jsonb filter below IS the
 * per-sandbox audit log (newest first, capped at 50).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const row = await getSandboxByRef(user.id, id);
  if (!row) return NextResponse.json({ error: 'sandbox not found' }, { status: 404 });

  const live = await sandboxdList();
  const liveEntry = live?.sandboxes.find((s) => s.id === row.id);
  const status = liveEntry?.state
    ? liveEntry.state === 'running'
      ? 'running'
      : 'stopped'
    : row.status;

  const steps = await db
    .select({
      id: traceSteps.id,
      traceId: traceSteps.traceId,
      status: traceSteps.status,
      startedAt: traceSteps.startedAt,
      durationMs: traceSteps.durationMs,
      meta: traceSteps.meta,
    })
    .from(traceSteps)
    .where(
      and(
        sql`${traceSteps.meta} ->> 'sandboxId' = ${row.id}`,
        sql`${traceSteps.meta} ->> 'command' is not null`,
      ),
    )
    .orderBy(desc(traceSteps.startedAt))
    .limit(50);

  return NextResponse.json({
    sandbox: {
      id: row.id,
      name: row.name,
      description: row.description,
      image: row.image,
      network: row.network,
      status,
      lastUsedAt: row.lastUsedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    },
    commands: steps.map((s) => ({
      id: s.id,
      traceId: s.traceId,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      command: typeof s.meta.command === 'string' ? s.meta.command : '',
      exitCode: typeof s.meta.exitCode === 'number' ? s.meta.exitCode : null,
      timedOut: s.meta.timedOut === true,
      durationMs: typeof s.meta.durationMs === 'number' ? s.meta.durationMs : s.durationMs,
    })),
  });
}

/**
 * DELETE /api/sandboxes/:id[?purge=1] — the UI's `sandbox_rm`: remove the
 * container, delete the row (frees the name). The /files work dir is
 * PRESERVED on the host unless `purge=1`. sandboxd unreachable → 502 and the
 * row stays, so a live container is never orphaned from its registry row.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const row = await getSandboxByRef(user.id, id);
  if (!row) return NextResponse.json({ error: 'sandbox not found' }, { status: 404 });

  const purge = new URL(req.url).searchParams.get('purge') === '1';
  const ok = await sandboxdRm(row.id, purge);
  if (!ok) {
    return NextResponse.json(
      { error: 'sandboxd is unreachable — the sandbox was not removed. Try again shortly.' },
      { status: 502 },
    );
  }
  await deleteSandboxRow(row.id);
  return NextResponse.json({ removed: row.name, filesPreserved: !purge });
}
