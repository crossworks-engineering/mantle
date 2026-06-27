'use client';

import { Boxes, DollarSign, Sparkles, UserCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { formatMicroUsd } from '@/lib/traces-format';
import { formatCount } from '@/lib/format-bytes';
import { Spinner } from '@/components/ui/spinner';
import { KpiCards, type Kpi } from '@/components/dashboard/kpi-cards';
import { SpendChart } from '@/components/dashboard/spend-chart';
import { IngestChart } from '@/components/dashboard/ingest-chart';
import { BrainBreakdown } from '@/components/dashboard/brain-breakdown';
import { BrainStats } from '@/components/dashboard/brain-stats';
import { OpsPanels } from '@/components/dashboard/ops-panels';
import type {
  BrainCounts,
  EmailStats,
  GraphIntegrity,
  HeartbeatStats,
  IngestDay,
  TelegramStats,
  VectorCounts,
} from '@/lib/dashboard';
import type { DailySpend, RecentFailure, TopError } from '@/lib/metrics';

type DashboardData = {
  brain: BrainCounts;
  vectors: VectorCounts;
  ingest: IngestDay[];
  spend30: DailySpend[];
  email: EmailStats;
  telegram: TelegramStats;
  heartbeats: HeartbeatStats;
  pendingTools: number;
  errs: TopError[];
  fails: RecentFailure[];
  integrity: GraphIntegrity;
};

/** Data-free dashboard body: fetches the brain-health bundle from
 *  GET /api/dashboard and renders the KPI cards, charts, and ops panels. */
export function DashboardClient() {
  const dashboardQuery = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiFetch<DashboardData>('/api/dashboard'),
  });

  if (dashboardQuery.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (dashboardQuery.isError && !dashboardQuery.data) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        Couldn&apos;t load the dashboard.
      </p>
    );
  }

  const { brain, vectors, ingest, spend30, email, telegram, heartbeats, pendingTools, errs, fails, integrity } =
    dashboardQuery.data;

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

  const pendingTotal = pendingTools;

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
      hint: `${pendingTools} tool approvals`,
      icon: UserCheck,
      accent: pendingTotal > 0,
      href: '/pending',
    },
  ];

  return (
    <>
      <KpiCards items={kpis} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SpendChart data={spend30} />
        <IngestChart data={ingest} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BrainBreakdown nodesByType={brain.nodesByType} entitiesByKind={brain.entitiesByKind} />
        <BrainStats vectors={vectors} brain={brain} integrity={integrity} />
      </div>

      <OpsPanels
        email={email}
        telegram={telegram}
        heartbeats={heartbeats}
        topErrors={errs}
        recentFailures={fails}
      />
    </>
  );
}
