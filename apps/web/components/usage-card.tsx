import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  recentAgentContext,
  spendInRange,
  type AgentContext,
  type SpendRange,
} from '@/lib/metrics';
import { formatMicroUsd } from '@/lib/traces-format';
import { UsageCardPills } from '@/components/usage-card-pills';
import { VitalsBar, vitalsLevel, type VitalsLevel } from '@/components/dashboard/vitals-bar';

const SPEND_RANGE_COOKIE = 'mantle_spend_range';
const VALID_RANGES: SpendRange[] = ['day', 'week', 'month'];

function readRange(value: string | undefined): SpendRange {
  return (VALID_RANGES as string[]).includes(value ?? '') ? (value as SpendRange) : 'day';
}

function formatSpend(microUsd: number): string {
  if (microUsd === 0) return '—';
  return formatMicroUsd(microUsd);
}

const RANGE_LABEL: Record<SpendRange, string> = {
  day: 'last 24h',
  week: 'last 7d',
  month: 'last 30d',
};

export async function UsageCard({ ownerId }: { ownerId: string }) {
  const cookieStore = await cookies();
  const range = readRange(cookieStore.get(SPEND_RANGE_COOKIE)?.value);
  const [spend, contexts] = await Promise.all([
    spendInRange(ownerId, range),
    recentAgentContext(ownerId),
  ]);

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
        <UsageCardPills current={range} />
        {contexts.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
            {contexts.map((c) => (
              <AgentContextRow key={c.agentId} ctx={c} />
            ))}
          </ul>
        )}
      </div>

      {/* Collapsed rail: a small price tag + a context circle. */}
      <div className="hidden flex-col items-center gap-2 border-b border-border px-1 py-3 group-data-[nav-collapsed=true]/shell:flex">
        <Link
          href="/debug"
          title={`${formatSpend(spend.costMicroUsd)} · ${RANGE_LABEL[range]} · ${spend.runs} runs`}
          className="max-w-full truncate text-[10px] font-semibold tabular-nums text-foreground hover:text-primary"
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
