/**
 * The service gateway's call log (migration 0358; docs/gateway.md): one
 * `gateway_calls` row per call the gateway answered or refused. The gateway
 * holds no database login: it sends its rows to the brain in batches
 * (POST /api/gateway/calls, its token), and the brain writes them here,
 * outside every scope, and reaps rows past 90 days. A lost batch loses its
 * rows; a call never waits on the log. Read by the connectors area
 * (/api/gateway-services, gateway_service_list).
 */
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { runAsActor, systemActor } from './actor';
import { systemDb } from './gateway/handles';
import { gatewayCalls, type GatewayCallRow } from './schema/gateway-services';

const uuidOrNull = (v: string | null | undefined): string | null =>
  v && UUID_RE.test(v) ? v.toLowerCase() : null;

/** Rows older than this go (reapGatewayCalls, run by the brain's call
 *  route at most once an hour). */
export const GATEWAY_CALLS_RETENTION_DAYS = 90;
/** The most rows one batch from the gateway may carry. */
export const GATEWAY_CALL_BATCH_MAX = 500;

/** One call as the gateway saw it. */
export type GatewayCallEntry = Readonly<{
  serviceSlug: string;
  method: string;
  path: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  caller: string | null;
  loginId: string | null;
  refusal: string | null;
}>;

const GATEWAY_CALL_ACTOR = systemActor('audit:gateway-call');

const cap = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const count = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
const text = (s: unknown, n: number) => (typeof s === 'string' && s ? s.slice(0, n) : null);

/** A batch as the gateway sent it, shaped and capped: every field coerced
 *  to its column (a batch is the gateway's, but checked as any input is),
 *  or null when it is no batch. */
export function gatewayCallBatch(body: unknown): GatewayCallEntry[] | null {
  const calls = (body as { calls?: unknown } | null)?.calls;
  if (!Array.isArray(calls) || calls.length > GATEWAY_CALL_BATCH_MAX) return null;
  return calls
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({
      serviceSlug: cap(c.serviceSlug, 64),
      method: cap(c.method, 16),
      path: cap(c.path, 512),
      status: count(c.status),
      requestBytes: count(c.requestBytes),
      responseBytes: count(c.responseBytes),
      durationMs: Math.min(count(c.durationMs), 2_147_483_647),
      caller: text(c.caller, 200),
      loginId: typeof c.loginId === 'string' ? uuidOrNull(c.loginId) : null,
      refusal: text(c.refusal, 64),
    }));
}

/** Write one batch of call rows (one statement). */
export async function insertGatewayCalls(entries: readonly GatewayCallEntry[]): Promise<number> {
  if (entries.length === 0) return 0;
  await runAsActor(GATEWAY_CALL_ACTOR, () => systemDb.insert(gatewayCalls).values([...entries]));
  return entries.length;
}

/** Remove rows past the retention. The count removed. */
export async function reapGatewayCalls(
  days: number = GATEWAY_CALLS_RETENTION_DAYS,
): Promise<number> {
  const before = new Date(Date.now() - days * 86_400_000);
  const gone = await runAsActor(systemActor('maintenance:gateway-calls-reap'), () =>
    systemDb
      .delete(gatewayCalls)
      .where(lt(gatewayCalls.createdAt, before))
      .returning({ id: gatewayCalls.id }),
  );
  return gone.length;
}

/** The newest calls, newest first, of one service or all. */
export async function listGatewayCalls(
  filter: Readonly<{ slug?: string; before?: Date; limit?: number }> = {},
): Promise<GatewayCallRow[]> {
  const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 200);
  return systemDb
    .select()
    .from(gatewayCalls)
    .where(
      and(
        filter.slug ? eq(gatewayCalls.serviceSlug, filter.slug) : undefined,
        filter.before ? lt(gatewayCalls.createdAt, filter.before) : undefined,
      ),
    )
    .orderBy(desc(gatewayCalls.createdAt), desc(gatewayCalls.id))
    .limit(limit);
}

/** Calls counted by service, status and refusal over the last `hours`
 *  (default 24): what a list shows by default, with no path and no caller
 *  (a path can name a client record). */
export async function gatewayCallCounts(
  filter: Readonly<{ slug?: string; hours?: number }> = {},
): Promise<
  Array<{ slug: string; status: number; refusal: string | null; calls: number; last: Date }>
> {
  const hours = Math.min(Math.max(1, Math.floor(filter.hours ?? 24)), 24 * 90);
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await systemDb
    .select({
      slug: gatewayCalls.serviceSlug,
      status: gatewayCalls.status,
      refusal: gatewayCalls.refusal,
      calls: sql<number>`count(*)::int`,
      last: sql<Date>`max(${gatewayCalls.createdAt})`,
    })
    .from(gatewayCalls)
    .where(
      and(
        gt(gatewayCalls.createdAt, since),
        filter.slug ? eq(gatewayCalls.serviceSlug, filter.slug) : undefined,
      ),
    )
    .groupBy(gatewayCalls.serviceSlug, gatewayCalls.status, gatewayCalls.refusal)
    .orderBy(desc(sql`count(*)`))
    .limit(200);
  return rows.map((r) => ({ ...r, last: new Date(r.last) }));
}
