'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { formatMicroUsd } from '@mantle/web-ui/traces-format';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import type { AgentSpend, ModelSpend } from '@server/lib/metrics';

type SpendData = { modelSpend: ModelSpend[]; agentSpend: AgentSpend[] };

/** Data-free spend tables (7d): fetches GET /api/debug/spend. */
export function SpendClient() {
  const spendQuery = useQuery({
    queryKey: ['debug', 'spend'],
    queryFn: () => apiFetch<SpendData>('/api/debug/spend'),
  });

  if (spendQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (spendQuery.isError && !spendQuery.data) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
        Couldn&apos;t load spend.
      </p>
    );
  }

  const { modelSpend, agentSpend } = spendQuery.data;

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Spend by model (7d)
        </h2>
        {modelSpend.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            No model spend recorded in the last 7 days.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Model</th>
                  <th className="px-3 py-2 text-right font-semibold">Calls</th>
                  <th className="px-3 py-2 text-right font-semibold">Tokens in</th>
                  <th className="px-3 py-2 text-right font-semibold">Tokens out</th>
                  <th className="px-3 py-2 text-right font-semibold">Cache read</th>
                  <th className="px-3 py-2 text-right font-semibold">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {modelSpend.map((m) => (
                  <tr key={m.model}>
                    <td className="px-3 py-2 font-mono text-xs">{m.model}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.calls}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {m.tokensIn.toLocaleString('en-GB')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {m.tokensOut.toLocaleString('en-GB')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {m.cacheReadTokens.toLocaleString('en-GB')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMicroUsd(m.costMicroUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Spend by agent (7d)
        </h2>
        {agentSpend.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            No agent spend recorded in the last 7 days.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Agent</th>
                  <th className="px-3 py-2 text-right font-semibold">Runs</th>
                  <th className="px-3 py-2 text-right font-semibold">Tokens in</th>
                  <th className="px-3 py-2 text-right font-semibold">Tokens out</th>
                  <th className="px-3 py-2 text-right font-semibold">Cache read</th>
                  <th className="px-3 py-2 text-right font-semibold">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {agentSpend.map((a) => (
                  <tr key={a.agentId ?? 'unknown'}>
                    <td className="px-3 py-2">
                      {a.agentName ?? '(unattributed)'}
                      {a.agentSlug && (
                        <span className="ml-1 text-xs text-muted-foreground">/ {a.agentSlug}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{a.runs}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{a.tokensIn}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{a.tokensOut}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {a.cacheReadTokens}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMicroUsd(a.costMicroUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
