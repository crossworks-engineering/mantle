import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { queryAuditLog } from '@/lib/audit-query';
import { AuditClient } from './audit-client';

/**
 * Audit log: who did what, when. URL-driven SSR per the /pages convention —
 * filters (actor email, action, date range) and page live in the query string.
 * The query itself is shared with GET /api/audit (lib/audit-query.ts) so the
 * split client's client-fetch screen and this SSR page can't drift. Any
 * logged-in admin may view it (it's a trail, not a secret); rows are written
 * by lib/audit.ts producers.
 */
export default async function AuditSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    actor?: string;
    action?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  await requireOwner();
  const sp = await searchParams;

  const result = await queryAuditLog({
    actor: sp.actor,
    action: sp.action,
    from: sp.from,
    to: sp.to,
    page: Number.parseInt(sp.page ?? '1', 10) || 1,
  });

  return (
    <>
      <SetPageTitle title="Audit log" />
      <AuditClient
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        actor={sp.actor?.trim() ?? ''}
        action={sp.action?.trim() ?? ''}
        from={sp.from ?? ''}
        to={sp.to ?? ''}
        actorOptions={result.actorOptions}
        actionOptions={result.actionOptions}
      />
    </>
  );
}
