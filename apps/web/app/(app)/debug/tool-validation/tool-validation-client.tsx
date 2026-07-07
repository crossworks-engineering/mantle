'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import type { ToolValidationAgg, ToolValidationEvent } from '@/lib/metrics';

type ToolValidationData = {
  mode: 'off' | 'warn' | 'enforce';
  days: number;
  byTool: ToolValidationAgg[];
  recent: ToolValidationEvent[];
};

const MODE_COPY: Record<ToolValidationData['mode'], { label: string; detail: string }> = {
  warn: {
    label: 'warn (observing)',
    detail:
      'Safe repairs are applied; violations are recorded here but calls still run. ' +
      'Set MANTLE_TOOL_VALIDATION=enforce once the violations below look like model ' +
      'mistakes rather than schema bugs.',
  },
  enforce: {
    label: 'enforce',
    detail:
      'Violations block the call with a teaching error the model can act on. ' +
      'Everything listed under "violations" below was bounced.',
  },
  off: {
    label: 'off',
    detail:
      'Validation is disabled — no repairs, no telemetry. This page will stay empty ' +
      'until MANTLE_TOOL_VALIDATION is unset (warn) or set to enforce.',
  },
};

/** Data-free telemetry view: fetches GET /api/debug/tool-validation. */
export function ToolValidationClient() {
  const [days, setDays] = useState(7);
  const query = useQuery({
    queryKey: ['debug', 'tool-validation', days],
    queryFn: () => apiFetch<ToolValidationData>(`/api/debug/tool-validation?days=${days}`),
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
        Couldn&apos;t load tool-validation telemetry.
      </p>
    );
  }

  const { mode, byTool, recent } = query.data;
  const modeCopy = MODE_COPY[mode] ?? MODE_COPY.warn;

  return (
    <>
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Validation mode
            </h2>
            <Badge variant={mode === 'enforce' ? 'default' : 'secondary'}>{modeCopy.label}</Badge>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{modeCopy.detail}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Window
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={1}>24h</option>
            <option value={7}>7d</option>
            <option value={30}>30d</option>
            <option value={90}>90d</option>
          </select>
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Flagged calls by tool
        </h2>
        {byTool.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            Nothing flagged in this window. Clean calls write no telemetry — this is a list of
            problems, not a call count.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Tool</th>
                  <th className="px-3 py-2 text-right font-semibold">Flagged</th>
                  <th className="px-3 py-2 text-right font-semibold">Repairs</th>
                  <th className="px-3 py-2 text-right font-semibold">Unknown keys</th>
                  <th className="px-3 py-2 text-right font-semibold">Violations</th>
                  <th className="px-3 py-2 text-right font-semibold">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {byTool.map((t) => (
                  <tr key={t.tool}>
                    <td className="px-3 py-2 font-mono text-xs">{t.tool}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.flaggedCalls}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.withRepairs}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.withUnknownKeys}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.withViolations > 0 ? (
                        <span className="font-semibold text-destructive">{t.withViolations}</span>
                      ) : (
                        t.withViolations
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                      {new Date(t.lastAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Violations</span> are the enforce
          question — calls warn mode let through that enforce would bounce with a teaching
          error. <span className="font-medium text-foreground">Repairs</span> are drift the
          coercer already absorbs (free in every mode). A violation cluster on one tool
          usually means a schema bug to fix, not a model mistake.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recent flagged calls
        </h2>
        {recent.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            No flagged calls in this window.
          </p>
        ) : (
          <ul className="space-y-2">
            {recent.map((e) => (
              <li key={e.stepId} className="rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <code className="font-mono text-xs">{e.tool}</code>
                  {e.violations.length > 0 && (
                    <Badge variant="destructive">
                      {e.violations.length} violation{e.violations.length === 1 ? '' : 's'}
                    </Badge>
                  )}
                  {e.repairs.length > 0 && (
                    <Badge variant="secondary">
                      {e.repairs.length} repair{e.repairs.length === 1 ? '' : 's'}
                    </Badge>
                  )}
                  {e.unknownKeys.length > 0 && (
                    <Badge variant="outline">
                      {e.unknownKeys.length} unknown key{e.unknownKeys.length === 1 ? '' : 's'}
                    </Badge>
                  )}
                  <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                    {new Date(e.startedAt).toLocaleString()}
                    <Link className="underline hover:text-foreground" href={`/traces/${e.traceId}`}>
                      trace
                    </Link>
                  </span>
                </div>
                {(e.violations.length > 0 || e.unknownKeys.length > 0 || e.repairs.length > 0) && (
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {e.violations.map((v, i) => (
                      <p key={`v${i}`} className="text-destructive">
                        {v}
                      </p>
                    ))}
                    {e.unknownKeys.map((k, i) => (
                      <p key={`k${i}`}>
                        unknown key <code className="font-mono">{k.key}</code>
                        {k.suggestion ? (
                          <>
                            {' '}
                            — did you mean <code className="font-mono">{k.suggestion}</code>?
                          </>
                        ) : null}
                      </p>
                    ))}
                    {e.repairs.map((r, i) => (
                      <p key={`r${i}`}>
                        repaired <code className="font-mono">{r.key}</code> ({r.kind}
                        {r.note ? `: ${r.note}` : ''})
                      </p>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
