import { db, auditLog, and, eq, gte, lt, desc, sql } from '@mantle/db';

export const AUDIT_PAGE_SIZE = 50;

export type AuditQueryParams = {
  actor?: string;
  action?: string;
  /** yyyy-mm-dd (from <input type="date">). */
  from?: string;
  /** yyyy-mm-dd, inclusive — bounded at the start of the NEXT day. */
  to?: string;
  page?: number;
};

export type AuditRowDto = {
  id: string;
  actorEmail: string;
  action: string;
  method: string | null;
  path: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

export type AuditQueryResult = {
  rows: AuditRowDto[];
  total: number;
  page: number;
  pageSize: number;
  actorOptions: string[];
  actionOptions: string[];
};

/**
 * The audit-log list query — one implementation behind BOTH surfaces: the
 * /settings/audit SSR page (same-origin today) and GET /api/audit (the
 * client-fetch path for the split client). Filters and pagination mirror the
 * URL-driven convention (/pages et al).
 */
export async function queryAuditLog(params: AuditQueryParams): Promise<AuditQueryResult> {
  const page = Math.max(1, params.page || 1);
  const actor = params.actor?.trim() || '';
  const action = params.action?.trim() || '';
  const from =
    params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from)
      ? new Date(`${params.from}T00:00:00`)
      : null;
  const toExclusive =
    params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to)
      ? new Date(new Date(`${params.to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000)
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
      .limit(AUDIT_PAGE_SIZE)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(filters),
    db.selectDistinct({ email: auditLog.actorEmail }).from(auditLog).orderBy(auditLog.actorEmail),
    db.selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(auditLog.action),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      actorEmail: r.actorEmail,
      action: r.action,
      method: r.method,
      path: r.path,
      ip: r.ip,
      detail: (r.detail ?? null) as Record<string, unknown> | null,
      createdAt: r.createdAt.toISOString(),
    })),
    total: countRows[0]?.count ?? 0,
    page,
    pageSize: AUDIT_PAGE_SIZE,
    actorOptions: actorRows.map((r) => r.email),
    actionOptions: actionRows.map((r) => r.action),
  };
}
