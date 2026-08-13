'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { formatMicroUsd } from '@mantle/web-ui/traces-format';
import type { AgentContext, SpendRange } from '@mantle/client-types';
import { UsageCardPills } from '@/components/usage-card-pills';
import { VitalsBar, vitalsLevel, type VitalsLevel } from '@/components/dashboard/vitals-bar';

type Spend = { range: SpendRange; costMicroUsd: number; runs: number };
type UsagePayload = { spend: Spend; contexts: AgentContext[] };

/**
 * Sidebar usage card — spend over a day/week/month window, plus how full each
 * recently-active agent's context window got.
 *
 * Restored after the carve (fc1708ea) deleted it: it was a server component
 * reading the DB in-process, which the zero-secret owner UI cannot do. Same
 * numbers and same layout, now fed by GET /api/metrics/usage.
 *
 * Read the numbers for what they are. `contexts` is every agent that ran a
 * responder turn in the last 24h, not the assistant you happen to have open,
 * and each row is the PEAK prompt size of that agent's most recent turn rather
 * than a live reading — it doesn't move until a turn completes, and it ages
 * out after 24h of silence. The percentage divides those tokens by the limit
 * for the agent's currently-configured model, so swapping a model skews it
 * until the next turn. The tooltip names the limit's source (live catalogue vs
 * static fallback) so a number can be trusted or discounted at a glance.
 */
export function UsageCard({ initialRange }: { initialRange: SpendRange }) {
  const [range, setRange] = useState<SpendRange>(initialRange);

  const usage = useQuery({
    queryKey: ['metrics', 'usage', range],
    queryFn: () => apiFetch<UsagePayload>(`/api/metrics/usage?range=${range}`),
    // The card is ambient furniture, not a screen the user is reading closely.
    // A slow poll keeps it honest without putting an aggregate query behind
    // every tab on a short timer.
    refetchInterval: 60_000,
  });

  // Nothing to say yet, and an empty bordered box in the sidebar reads as a
  // broken card. Stay invisible until there are numbers.
  if (!usage.data) return null;

  const { spend, contexts } = usage.data;
  // Most relevant context window to surface when collapsed: the first with a
  // known percentage, else the most recent.
  const topCtx = contexts.find((c) => c.pct != null) ?? contexts[0] ?? null;

  return (
    <>
      {/* Full card (expanded rail) */}
      <div className="border-b border-border px-4 py-2 group-data-[nav-collapsed=true]/shell:hidden">
        <Link
          href="/debug"
          className="flex items-baseline justify-between text-sm hover:text-foreground"
          title={`${spend.runs} runs in ${RANGE_LABEL[range]}`}
        >
          <span className="font-semibold tabular-nums">{formatSpend(spend.costMicroUsd)}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {RANGE_LABEL[range]}
          </span>
        </Link>
        <UsageCardPills current={range} onPick={setRange} pending={usage.isFetching} />
        {contexts.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
            {contexts.map((c) => (
              <AgentContextRow key={c.agentId} ctx={c} />
            ))}
          </ul>
        )}
      </div>

      {/* Collapsed rail: a small price tag + a context circle. The price tag's
          hover was `text-primary` pre-carve; the use-ink-for-text rule has
          landed since, and the fill is not legible as ink. */}
      <div className="hidden flex-col items-center gap-2 border-b border-border px-1 py-3 group-data-[nav-collapsed=true]/shell:flex">
        <Link
          href="/debug"
          title={`${formatSpend(spend.costMicroUsd)} · ${RANGE_LABEL[range]} · ${spend.runs} runs`}
          className="max-w-full truncate text-[10px] font-semibold tabular-nums text-foreground hover:text-primary-ink"
        >
          {formatSpend(spend.costMicroUsd)}
        </Link>
        {topCtx?.pct != null && (
          <ContextRing
            pct={topCtx.pct}
            title={`${topCtx.agentName ?? topCtx.agentSlug ?? 'agent'} — ${Math.round(
              topCtx.pct * 100,
            )}% of context window`}
          />
        )}
      </div>
    </>
  );
}

const RANGE_LABEL: Record<SpendRange, string> = {
  day: 'last 24h',
  week: 'last 7d',
  month: 'last 30d',
};

function formatSpend(microUsd: number): string {
  if (microUsd === 0) return '—';
  return formatMicroUsd(microUsd);
}

/** Stroke colours mirroring the vitals fill scheme, for the collapsed-rail
 *  donut (literal classes so the Tailwind scanner keeps them). */
const RING_STROKE: Record<VitalsLevel, string> = {
  unknown: 'stroke-muted-foreground/40',
  ok: 'stroke-primary',
  warn: 'stroke-amber-500',
  crit: 'stroke-destructive',
};

/** A small donut showing how full an agent's context window is — the
 *  collapsed-rail stand-in for the full per-agent progress bars. Colour
 *  escalates with fill, matching the VitalsBar scheme. */
function ContextRing({ pct, title }: { pct: number; title?: string }) {
  const r = 10;
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, pct));
  return (
    <div className="relative grid size-7 place-items-center" title={title}>
      <svg viewBox="0 0 28 28" className="size-7 -rotate-90" aria-hidden>
        <circle cx="14" cy="14" r={r} fill="none" strokeWidth="3" className="stroke-muted" />
        <circle
          cx="14"
          cy="14"
          r={r}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          className={RING_STROKE[vitalsLevel(clamped * 100)]}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - clamped)}
        />
      </svg>
      <span className="absolute text-[8px] font-medium tabular-nums text-muted-foreground">
        {Math.round(clamped * 100)}
      </span>
    </div>
  );
}

function AgentContextRow({ ctx }: { ctx: AgentContext }) {
  const label = ctx.agentName ?? ctx.agentSlug ?? 'agent';
  const tokensLabel = formatTokens(ctx.lastTokensIn);
  const pctLabel = ctx.pct != null ? `${Math.round(ctx.pct * 100)}%` : '—';
  const limitLabel = ctx.contextLimit ? formatTokens(ctx.contextLimit) : 'unknown';
  // Provenance of the limit, so the number is trustworthy at a glance:
  // 'live' = fetched from OpenRouter, 'fallback' = static table.
  const sourceLabel =
    ctx.contextSource === 'live' ? 'live' : ctx.contextSource === 'fallback' ? 'fallback' : '';
  const title =
    ctx.pct != null
      ? `${label} (${ctx.modelSlug}) — last turn ${tokensLabel} / ${limitLabel} tokens` +
        (sourceLabel ? ` · limit from ${sourceLabel}` : '')
      : `${label} (${ctx.modelSlug}) — last turn ${tokensLabel} tokens · context limit unknown for this model`;
  return (
    <li className="flex items-center gap-2 text-[11px]" title={title}>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      <VitalsBar className="w-12" pct={ctx.pct != null ? ctx.pct * 100 : null} />
      <span className="w-8 text-right tabular-nums text-muted-foreground">{pctLabel}</span>
    </li>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
