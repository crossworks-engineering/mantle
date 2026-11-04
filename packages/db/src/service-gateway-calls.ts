/**
 * The service gateway's call log (migration 0358; docs/gateway.md): one
 * `gateway_calls` row per call the gateway answered or refused. Written and
 * reaped only by the gateway process (server/gateway), outside every scope;
 * read by the connectors area (/api/gateway-services, gateway_service_list).
 *
 * Fire and forget, bounded, as the MCP call log (mcp-call-log.ts): a lost
 * row is counted and said at most every ten minutes, never retried, and
 * never fails the call it describes.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { runAsActor, systemActor } from './actor';
import { systemDb } from './gateway/handles';
import { gatewayCalls, type GatewayCallRow } from './schema/gateway-services';

const uuidOrNull = (v: string | null | undefined): string | null =>
  v && UUID_RE.test(v) ? v.toLowerCase() : null;

/** Rows older than this go (the gateway's own hourly reap). */
export const GATEWAY_CALLS_RETENTION_DAYS = 90;
/** Rows in flight at once; past it a row is dropped and counted. */
export const GATEWAY_CALL_LOG_MAX_IN_FLIGHT = 64;

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

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const count = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

async function insertCall(e: GatewayCallEntry): Promise<void> {
  await runAsActor(GATEWAY_CALL_ACTOR, () =>
    systemDb.insert(gatewayCalls).values({
      serviceSlug: cap(e.serviceSlug, 64),
      method: cap(e.method, 16),
      path: cap(e.path, 512),
      status: count(e.status),
      requestBytes: count(e.requestBytes),
      responseBytes: count(e.responseBytes),
      durationMs: Math.min(count(e.durationMs), 2_147_483_647),
      caller: e.caller ? cap(e.caller, 200) : null,
      loginId: uuidOrNull(e.loginId),
      refusal: e.refusal ? cap(e.refusal, 64) : null,
    }),
  );
}

let writeCall: (e: GatewayCallEntry) => Promise<void> = insertCall;

/** Tests: take each row instead of inserting it (null: insert again). */
export function setGatewayCallWriter(fn: ((e: GatewayCallEntry) => Promise<void>) | null): void {
  writeCall = fn ?? insertCall;
}

const inFlight = new Set<Promise<void>>();
const stats = { written: 0, dropped: 0, failed: 0 };
let lastWarnAt = 0;
const WARN_EVERY_MS = 10 * 60_000;

function lost(what: string, err?: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = now;
  console.error(
    `[gateway-call-log] ${what} (dropped ${stats.dropped}, failed ${stats.failed} so far)`,
    err ?? '',
  );
}

/** Record one call: fire and forget, bounded. Never throws. */
export function recordGatewayCall(entry: GatewayCallEntry): void {
  if (inFlight.size >= GATEWAY_CALL_LOG_MAX_IN_FLIGHT) {
    stats.dropped += 1;
    lost('a call was not logged: too many rows in flight');
    return;
  }
  const row = Promise.resolve()
    .then(() => writeCall(entry))
    .then(
      () => {
        stats.written += 1;
      },
      (err: unknown) => {
        stats.failed += 1;
        lost('a call was not logged: its insert failed', err);
      },
    );
  inFlight.add(row);
  void row.finally(() => inFlight.delete(row));
}

/** The counts since the process started (tests, diagnostics). */
export function gatewayCallLogStats(): Readonly<typeof stats> {
  return { ...stats };
}

/** Tests and shutdown: resolves once every row started has settled. */
export async function gatewayCallsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
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
