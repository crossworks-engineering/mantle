import Link from 'next/link';
import { Boxes, DollarSign, Sparkles, UserCheck } from 'lucide-react';
import { requireOwner } from '@/lib/auth';
import { formatMicroUsd } from '@/lib/traces-format';
import { formatCount } from '@/lib/format-bytes';
import { recentFailures, spendByDay, topErrors } from '@/lib/metrics';
import {
  brainCounts,
  emailStats,
  heartbeatStats,
  nodesCreatedByDay,
  pendingToolCount,
  telegramStats,
  vectorCounts,
} from '@/lib/dashboard';
import { SystemVitals } from '@/components/dashboard/system-vitals';
import { KpiCards, type Kpi } from '@/components/dashboard/kpi-cards';
import { SpendChart } from '@/components/dashboard/spend-chart';
import { IngestChart } from '@/components/dashboard/ingest-chart';
import { BrainBreakdown } from '@/components/dashboard/brain-breakdown';
import { BrainStats } from '@/components/dashboard/brain-stats';
import { OpsPanels } from '@/components/dashboard/ops-panels';
import { SetPageTitle } from '@/components/layout/page-title';

/**
 * Dashboard — the "brain health" overview. Server-rendered (fast DB metrics
 * via Promise.all); live host/Postgres vitals come from the <SystemVitals>
 * island polling /api/health. The deep operator view stays at /debug.
 */
export default async function DashboardPage() {
  const user = await requireOwner();

  const [brain, vectors, ingest, spend30, email, telegram, heartbeats, pendingTools, errs, fails] =
    await Promise.all([
      brainCounts(user.id),
      vectorCounts(user.id),
      nodesCreatedByDay(user.id, 30),
      spendByDay(user.id, 30),
      emailStats(user.id),
      telegramStats(user.id),
      heartbeatStats(user.id),
      pendingToolCount(user.id),
      topErrors(user.id, 7),
      recentFailures(user.id, 10),
    ]);

  // 7d vs prior-7d spend for the KPI trend.
  const last7 = spend30.slice(-7).reduce((a, d) => a + d.costMicroUsd, 0);
  const prior7 = spend30.slice(-14, -7).reduce((a, d) => a + d.costMicroUsd, 0);
  const spendTrend =
    prior7 > 0
      ? (() => {
          const pct = ((last7 - prior7) / prior7) * 100;
          return {
            dir: (last7 >= prior7 ? 'up' : 'down') as 'up' | 'down',
            text: `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`,
            good: last7 <= prior7,
          };
        })()
      : undefined;

  const pendingTotal = email.pendingSenders + pendingTools;

  const kpis: Kpi[] = [
    {
      label: 'Vectors indexed',
      value: formatCount(vectors.vectorsTotal),
      hint: `${formatCount(vectors.nodesIndexed)} nodes · ${formatCount(vectors.factsIndexed)} facts · ${formatCount(vectors.entitiesIndexed)} entities`,
      icon: Sparkles,
    },
    {
      label: 'Brain nodes',
      value: formatCount(brain.nodesTotal),
      hint: `${formatCount(brain.entitiesTotal)} entities · ${formatCount(brain.edgesTotal)} edges`,
      icon: Boxes,
    },
    {
      label: 'Spend (7d)',
      value: formatMicroUsd(last7),
      hint: `prior 7d: ${formatMicroUsd(prior7)}`,
      icon: DollarSign,
      trend: spendTrend,
      href: '/debug',
    },
    {
      label: 'Pending review',
      value: formatCount(pendingTotal),
      hint: `${email.pendingSenders} senders · ${pendingTools} tool approvals`,
      icon: UserCheck,
      accent: pendingTotal > 0,
      href: email.pendingSenders > 0 ? '/settings/senders' : '/pending',
    },
  ];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <SetPageTitle title="Dashboard" />
      <header className="flex flex-wrap items-center justify-end gap-2">
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/debug" className="text-primary underline-offset-2 hover:underline">
            Operator view
          </Link>
          <Link href="/traces" className="text-primary underline-offset-2 hover:underline">
            Traces
          </Link>
        </nav>
      </header>

      <SystemVitals />

      <KpiCards items={kpis} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SpendChart data={spend30} />
        <IngestChart data={ingest} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BrainBreakdown nodesByType={brain.nodesByType} entitiesByKind={brain.entitiesByKind} />
        <BrainStats vectors={vectors} brain={brain} />
      </div>

      <OpsPanels
        email={email}
        telegram={telegram}
        heartbeats={heartbeats}
        topErrors={errs}
        recentFailures={fails}
      />
    </div>
  );
}
