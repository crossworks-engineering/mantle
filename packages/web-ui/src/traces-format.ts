/**
 * Pure types + format helpers for traces. No DB imports. Safe to pull
 * into a client component without dragging postgres-js / pg-boss /
 * other Node-only modules into the browser bundle.
 *
 * Server-only data fetching lives in `./traces.ts`, which re-exports
 * everything from this file so existing server callers don't need to
 * update their import sites.
 */

export type TraceSummary = {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  stepCount: number;
  subjectKind: string | null;
  subjectId: string | null;
  agentName: string | null;
  agentSlug: string | null;
  error: string | null;
};

export type TraceSort = 'started' | 'cost' | 'duration';
export type TraceSortDir = 'asc' | 'desc';

export type TraceFilter = {
  kinds?: string[];
  statuses?: string[];
  sinceHours?: number;
  limit?: number;
  offset?: number;
  sort?: TraceSort;
  dir?: TraceSortDir;
};

export type TraceStepSummary = {
  id: string;
  parentStepId: string | null;
  ordinal: number;
  name: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  meta: Record<string, unknown>;
  error: string | null;
};

export type TraceDetail = TraceSummary & {
  data: Record<string, unknown>;
  steps: TraceStepSummary[];
};

export function formatMicroUsd(microUsd: number): string {
  if (microUsd === 0) return '$0';
  const usd = microUsd / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
