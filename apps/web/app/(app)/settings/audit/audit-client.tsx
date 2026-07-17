'use client';

import { ScrollText } from 'lucide-react';
import { useListNav } from '@/lib/use-list-nav';
import { ListPager } from '@/components/layout/list-pager';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format-datetime';

export type AuditRow = {
  id: string;
  actorEmail: string;
  action: string;
  method: string | null;
  path: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

const ALL = '__all__';

/** Filter bar + table shell for the SSR audit page. Filters are URL-driven
 *  (useListNav) so the server re-queries; nothing is filtered client-side. */
export function AuditClient({
  rows,
  total,
  page,
  pageSize,
  actor,
  action,
  from,
  to,
  actorOptions,
  actionOptions,
}: {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  actor: string;
  action: string;
  from: string;
  to: string;
  actorOptions: string[];
  actionOptions: string[];
}) {
  const { pending, go } = useListNav();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-3">
        <div className="w-56 space-y-1.5">
          <Label className="text-xs text-muted-foreground">User</Label>
          <Select
            value={actor || ALL}
            onValueChange={(v) => go({ actor: v === ALL ? null : v, page: null })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All users</SelectItem>
              {actorOptions.map((email) => (
                <SelectItem key={email} value={email}>
                  {email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-56 space-y-1.5">
          <Label className="text-xs text-muted-foreground">Action</Label>
          <Select
            value={action || ALL}
            onValueChange={(v) => go({ action: v === ALL ? null : v, page: null })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All actions</SelectItem>
              {actionOptions.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="audit-from"
            type="date"
            className="w-40"
            value={from}
            onChange={(e) => go({ from: e.target.value || null, page: null })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="audit-to"
            type="date"
            className="w-40"
            value={to}
            onChange={(e) => go({ to: e.target.value || null, page: null })}
          />
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
            <ScrollText className="size-5" />
            <p>No audit entries match these filters.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">Time</TableHead>
                <TableHead className="w-56">User</TableHead>
                <TableHead className="w-44">Action</TableHead>
                <TableHead>Request</TableHead>
                <TableHead className="w-32">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDateTime(r.createdAt)}
                  </TableCell>
                  <TableCell className="max-w-56 truncate font-medium">{r.actorEmail}</TableCell>
                  <TableCell>
                    <Badge variant={r.action === 'auth.login_failed' ? 'destructive' : 'outline'}>
                      {r.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground">
                    {r.method || r.path
                      ? `${r.method ?? ''} ${r.path ?? ''}`.trim()
                      : detailSummary(r.detail)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {r.ip ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ListPager
        page={page}
        total={total}
        pageSize={pageSize}
        pending={pending}
        onGo={(p) => go({ page: p === 1 ? null : p })}
      />
    </div>
  );
}

function detailSummary(detail: Record<string, unknown> | null): string {
  if (!detail) return '—';
  const target = detail.targetEmail;
  return typeof target === 'string' ? `→ ${target}` : '—';
}
