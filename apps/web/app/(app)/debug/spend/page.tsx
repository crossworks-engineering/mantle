import { requireOwner } from '@/lib/auth';
import { spendByAgent, spendByModel } from '@/lib/metrics';
import { formatMicroUsd } from '@/lib/traces';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';

/** Debug → Spend: token spend broken down by model and by agent (7d). */
export default async function DebugSpendPage() {
  const user = await requireOwner();
  const [modelSpend7d, spend7d] = await Promise.all([
    spendByModel(user.id, 7),
    spendByAgent(user.id, 7),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Spend" />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Spend by model (7d)
        </h2>
        {modelSpend7d.length === 0 ? (
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
                {modelSpend7d.map((m) => (
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
        {spend7d.length === 0 ? (
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
                {spend7d.map((a) => (
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
    </div>
  );
}
