import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { db, auditLog, and, eq, gte, lt, desc, sql } from '@mantle/db';
import { AuditClient, type AuditRow } from './audit-client';

const PAGE_SIZE = 50;

/**
 * Audit log: who did what, when. URL-driven SSR per the /pages convention —
 * filters (actor email, action, date range) and page live in the query string;
 * this server page runs the filtered query and hands rows to the client shell.
 * Any logged-in admin may view it (it's a trail, not a secret); rows are
 * written by lib/audit.ts producers.
 */
export default async function AuditSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; action?: string; from?: string; to?: string; page?: string }>;
}) {
  await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const actor = sp.actor?.trim() || '';
  const action = sp.action?.trim() || '';
  // Dates arrive as yyyy-mm-dd from <input type="date">; `to` is inclusive, so
  // the query bounds at the start of the NEXT day.
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? new Date(`${sp.from}T00:00:00`) : null;
  const toExclusive =
    sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to)
      ? new Date(new Date(`${sp.to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000)
      : null;

  const filters = and(
    actor ? eq(auditLog.actorEmail, actor) : undefined,
    action ? eq(auditLog.action, action) : undefined,
    from ? gte(auditLog.createdAt, from) : undefined,
    toExclusive ? lt(auditLog.createdAt, toExclusive) : undefined,
  );

  const [rows, countRows, actorRows, actionRows] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(filters)
      .orderBy(desc(auditLog.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLog).where(filters),
    db.selectDistinct({ email: auditLog.actorEmail }).from(auditLog).orderBy(auditLog.actorEmail),
    db.selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(auditLog.action),
  ]);

  const total = countRows[0]?.count ?? 0;
  const serialized: AuditRow[] = rows.map((r) => ({
    id: r.id,
    actorEmail: r.actorEmail,
    action: r.action,
    method: r.method,
    path: r.path,
    ip: r.ip,
    detail: r.detail ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <>
      <SetPageTitle title="Audit log" />
      <AuditClient
        rows={serialized}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        actor={actor}
        action={action}
        from={sp.from ?? ''}
        to={sp.to ?? ''}
        actorOptions={actorRows.map((r) => r.email)}
        actionOptions={actionRows.map((r) => r.action)}
      />
    </>
  );
}
