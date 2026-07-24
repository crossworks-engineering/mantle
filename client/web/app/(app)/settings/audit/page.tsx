'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { SetPageTitle } from '@/components/layout/page-title';
import { AuditClient, type AuditRow } from './audit-client';

type AuditResponse = {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  actorOptions: string[];
  actionOptions: string[];
};

/**
 * Audit log: who did what, when. URL-driven per the /pages convention —
 * filters (actor email, action, date range) and page live in the query
 * string; the query itself runs server-side behind GET /api/audit
 * (lib/audit-query.ts on the server, shared with nothing else client-side —
 * this app is zero-secret and reads no DB).
 */
export default function AuditSettingsPage({
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
  const sp = use(searchParams);
  const qs = new URLSearchParams();
  if (sp.actor) qs.set('actor', sp.actor);
  if (sp.action) qs.set('action', sp.action);
  if (sp.from) qs.set('from', sp.from);
  if (sp.to) qs.set('to', sp.to);
  if (sp.page) qs.set('page', sp.page);

  const auditQuery = useQuery({
    queryKey: ['audit-log', qs.toString()],
    queryFn: () => apiFetch<AuditResponse>(`/api/audit?${qs.toString()}`),
    placeholderData: (prev) => prev,
  });

  const data = auditQuery.data;

  return (
    <>
      <SetPageTitle title="Audit log" />
      {data ? (
        <AuditClient
          rows={data.rows}
          total={data.total}
          page={data.page}
          pageSize={data.pageSize}
          actor={sp.actor?.trim() ?? ''}
          action={sp.action?.trim() ?? ''}
          from={sp.from ?? ''}
          to={sp.to ?? ''}
          actorOptions={data.actorOptions}
          actionOptions={data.actionOptions}
        />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          {auditQuery.isError ? 'Could not load the audit log.' : 'Loading…'}
        </p>
      )}
    </>
  );
}
