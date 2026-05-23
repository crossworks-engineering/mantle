import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { formatDateTime } from '@/lib/format-datetime';
import { formatDuration, formatMicroUsd, listTraces } from '@/lib/traces';
import { SetPageTitle } from '@/components/layout/page-title';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<string, string> = {
  responder_turn: 'Responder',
  extractor_run: 'Extractor',
  summarizer_run: 'Summarizer',
  reflector_run: 'Reflector',
  content_ingest: 'Ingest',
  photo_ingest: 'Photo',
  heartbeat_fire: 'Heartbeat',
  manual: 'Manual',
};

const KIND_OPTIONS: Array<[string, string]> = [
  ['responder_turn', 'Responder'],
  ['heartbeat_fire', 'Heartbeat'],
  ['extractor_run', 'Extractor'],
  ['summarizer_run', 'Summarizer'],
  ['reflector_run', 'Reflector'],
  ['content_ingest', 'Ingest'],
  ['photo_ingest', 'Photo'],
];

const STATUS_OPTIONS: Array<[string, string]> = [
  ['success', 'Success'],
  ['error', 'Error'],
  ['running', 'Running'],
  ['skipped', 'Skipped'],
];

const HOURS_OPTIONS: Array<[number, string]> = [
  [1, '1h'],
  [6, '6h'],
  [24, '24h'],
  [168, '7d'],
  [720, '30d'],
];

/** Default view: the traces an operator cares about — completed runs and
 *  failures. Running/skipped are opt-in via the Status chips. */
const DEFAULT_STATUSES = ['success', 'error'];

type SearchParams = {
  kind?: string | string[];
  status?: string | string[];
  hours?: string;
};

export default async function TracesPage(props: { searchParams?: Promise<SearchParams> }) {
  const user = await requireOwner();
  const sp = (await props.searchParams) ?? {};

  const kinds = toArray(sp.kind);
  const statuses = toArray(sp.status);
  const hours = sp.hours ? parseInt(sp.hours, 10) : 24;
  const effectiveStatuses = statuses.length > 0 ? statuses : DEFAULT_STATUSES;

  const rows = await listTraces(user.id, {
    kinds: kinds.length > 0 ? kinds : undefined,
    statuses: effectiveStatuses,
    sinceHours: hours,
    limit: 200,
  });

  const hasFilters = kinds.length > 0 || statuses.length > 0 || hours !== 24;

  return (
    <div className="space-y-5 px-6 py-8">
      <SetPageTitle title="Traces" />

      {/* Filters */}
      <div className="space-y-3 rounded-md border border-border p-3">
        <FilterRow label="Status">
          {STATUS_OPTIONS.map(([value, labelText]) => (
            <FilterChip
              key={value}
              href={tracesHref(kinds, toggle(effectiveStatuses, value), hours)}
              active={effectiveStatuses.includes(value)}
            >
              {labelText}
            </FilterChip>
          ))}
        </FilterRow>

        <FilterRow label="Kind">
          {KIND_OPTIONS.map(([value, labelText]) => (
            <FilterChip
              key={value}
              href={tracesHref(toggle(kinds, value), statuses, hours)}
              active={kinds.includes(value)}
            >
              {labelText}
            </FilterChip>
          ))}
        </FilterRow>

        <div className="flex items-center justify-between gap-3">
          <FilterRow label="Window">
            {HOURS_OPTIONS.map(([value, labelText]) => (
              <FilterChip
                key={value}
                href={tracesHref(kinds, statuses, value)}
                active={hours === value}
              >
                {labelText}
              </FilterChip>
            ))}
          </FilterRow>
          {hasFilters && (
            <Link
              href="/traces"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Reset filters
            </Link>
          )}
        </div>
      </div>

      {/* Results */}
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
          No traces match these filters. Widen the time window, adjust the status/kind chips, or
          trigger some activity (DM the bot, insert a note).
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Showing {rows.length} trace{rows.length === 1 ? '' : 's'}
            {rows.length === 200 ? ' (capped at 200)' : ''}.
          </p>
          <Table containerClassName="max-h-[calc(100vh-15rem)] rounded-md border border-border">
            <TableHeader className="sticky top-0 z-10 bg-muted [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Steps</TableHead>
                <TableHead>Agent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={statusRowClass(r.status)}>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    <Link href={`/traces/${r.id}`} className="hover:underline">
                      {formatDateTime(r.startedAt)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/traces/${r.id}`} className="font-medium hover:underline">
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className={statusTextClass(r.status)}>{r.status}</span>
                    {r.error && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {r.error.slice(0, 60)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(r.durationMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMicroUsd(r.costMicroUsd)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.tokensIn + r.tokensOut > 0 ? `${r.tokensIn + r.tokensOut}` : '—'}
                    {r.tokensCacheRead > 0 && (
                      <span className="ml-1 text-muted-foreground">({r.tokensCacheRead}c)</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.stepCount}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.agentName ?? '—'}
                    {r.agentSlug && (
                      <span className="ml-1 text-muted-foreground/70">/ {r.agentSlug}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** Toggle a value in/out of a list (returns a new list). */
function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/** Build a /traces URL from the given filter state (omits defaults). */
function tracesHref(kinds: string[], statuses: string[], hours: number): string {
  const p = new URLSearchParams();
  for (const k of kinds) p.append('kind', k);
  for (const s of statuses) p.append('status', s);
  if (hours !== 24) p.set('hours', String(hours));
  const q = p.toString();
  return q ? `/traces?${q}` : '/traces';
}

function statusRowClass(status: string): string {
  if (status === 'error') return 'bg-destructive/5 hover:bg-destructive/10';
  if (status === 'running')
    return 'bg-amber-100/40 hover:bg-amber-100/60 dark:bg-amber-950/30 dark:hover:bg-amber-950/40';
  return '';
}

function statusTextClass(status: string): string {
  if (status === 'success') return 'text-emerald-700 dark:text-emerald-300';
  if (status === 'error') return 'text-destructive';
  if (status === 'skipped') return 'text-muted-foreground';
  return 'text-amber-700 dark:text-amber-300';
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}
