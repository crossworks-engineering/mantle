import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { formatDateTime } from '@/lib/format-datetime';
import { formatDuration, formatMicroUsd, listTraces } from '@/lib/traces';
import { SetPageTitle } from '@/components/layout/page-title';

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

type SearchParams = {
  kind?: string | string[];
  status?: string | string[];
  hours?: string;
};

export default async function TracesPage(props: {
  searchParams?: Promise<SearchParams>;
}) {
  const user = await requireOwner();
  const sp = (await props.searchParams) ?? {};

  const kinds = toArray(sp.kind);
  const statuses = toArray(sp.status);
  const hours = sp.hours ? parseInt(sp.hours, 10) : 24;

  const rows = await listTraces(user.id, {
    kinds: kinds.length > 0 ? kinds : undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
    sinceHours: hours,
    limit: 200,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <SetPageTitle title="Traces" />

      {/* Filters */}
      <form className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Filter
        </span>
        <FilterGroup
          name="kind"
          current={kinds}
          options={[
            ['responder_turn', 'Responder'],
            ['heartbeat_fire', 'Heartbeat'],
            ['extractor_run', 'Extractor'],
            ['summarizer_run', 'Summarizer'],
            ['reflector_run', 'Reflector'],
            ['content_ingest', 'Ingest'],
            ['photo_ingest', 'Photo'],
          ]}
        />
        <FilterGroup
          name="status"
          current={statuses}
          options={[
            ['success', 'Success'],
            ['running', 'Running'],
            ['error', 'Error'],
            // skipped traces are the new visibility win — operator
            // filters here to see what the system considered and
            // declined to run, with a disposition string explaining
            // why. Migration 0029 + Layer A.
            ['skipped', 'Skipped'],
          ]}
        />
        <label className="flex items-center gap-1 text-xs">
          last
          <select
            name="hours"
            defaultValue={String(hours)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="1">1h</option>
            <option value="6">6h</option>
            <option value="24">24h</option>
            <option value="168">7d</option>
            <option value="720">30d</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md border border-input bg-background px-3 py-1 text-sm hover:bg-accent"
        >
          Apply
        </button>
        {(kinds.length > 0 || statuses.length > 0 || hours !== 24) && (
          <Link
            href="/traces"
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            clear
          </Link>
        )}
      </form>

      {/* Results */}
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          No traces in this window. Try widening the time range, or trigger
          some activity (DM the bot, insert a note).
        </p>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
          <table className="w-full text-sm">
            {/* `sticky top-0` pins the header inside the scroll
                container so it stays visible while scanning long
                runs. bg has to be solid (not /40) or rows show
                through during the scroll. */}
            <thead className="sticky top-0 z-10 bg-muted text-xs uppercase tracking-wider text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Started</th>
                <th className="px-3 py-2 text-left font-semibold">Kind</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-right font-semibold">Duration</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
                <th className="px-3 py-2 text-right font-semibold">Tokens</th>
                <th className="px-3 py-2 text-right font-semibold">Steps</th>
                <th className="px-3 py-2 text-left font-semibold">Agent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={
                    r.status === 'error'
                      ? 'bg-destructive/5 hover:bg-destructive/10'
                      : r.status === 'running'
                        ? 'bg-amber-100/40 hover:bg-amber-100/60 dark:bg-amber-950/30 dark:hover:bg-amber-950/40'
                        : 'hover:bg-muted/30'
                  }
                >
                  <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                    <Link href={`/traces/${r.id}`} className="hover:underline">
                      {formatDateTime(r.startedAt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <Link href={`/traces/${r.id}`} className="hover:underline">
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={
                        r.status === 'success'
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : r.status === 'error'
                            ? 'text-destructive'
                            : 'text-amber-700 dark:text-amber-300'
                      }
                    >
                      {r.status}
                    </span>
                    {r.error && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {r.error.slice(0, 60)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatDuration(r.durationMs)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatMicroUsd(r.costMicroUsd)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {r.tokensIn + r.tokensOut > 0
                      ? `${r.tokensIn + r.tokensOut}`
                      : '—'}
                    {r.tokensCacheRead > 0 && (
                      <span className="ml-1 text-muted-foreground">
                        ({r.tokensCacheRead}c)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {r.stepCount}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.agentName ?? '—'}
                    {r.agentSlug && (
                      <span className="ml-1 text-muted-foreground/70">/ {r.agentSlug}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function FilterGroup({
  name,
  current,
  options,
}: {
  name: string;
  current: string[];
  options: Array<[string, string]>;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground">{name}:</span>
      {options.map(([value, label]) => (
        <label
          key={value}
          className="flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-accent"
        >
          <input
            type="checkbox"
            name={name}
            value={value}
            defaultChecked={current.includes(value)}
            className="size-3"
          />
          {label}
        </label>
      ))}
    </div>
  );
}
