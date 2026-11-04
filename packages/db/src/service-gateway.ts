/**
 * The service gateway's registry and call log (migration 0358;
 * docs/gateway.md). The gateway (server/gateway) routes `/svc/<slug>/<path>`
 * only to an enabled `gateway_services` row, with a method and a path that
 * row allows, and writes one `gateway_calls` row per call it answered or
 * refused. Not to be confused with ./gateway/, the database gateway.
 *
 * Writes of a service (the connectors area's API and MCP tool) run at the
 * full-route spot tool-config: a row decides where calls go, as a tool
 * group's integration does. The rules a row must keep are
 * service-gateway-rules.ts (checkGatewayService), for every writer.
 *
 * The call log is service-gateway-calls.ts.
 */
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { systemDb } from './gateway/handles';
import { onFullSystemRoute } from './viewer';
import { gatewayServices, type GatewayServiceRow } from './schema/gateway-services';
import {
  checkGatewayService,
  GATEWAY_SLUG_RE,
  type GatewayServiceValues,
} from './service-gateway-rules';

export * from './service-gateway-rules';

/** Every service, by slug. */
export async function listGatewayServices(): Promise<GatewayServiceRow[]> {
  return systemDb.select().from(gatewayServices).orderBy(gatewayServices.slug);
}

/** One service by slug, or null. */
export async function getGatewayService(slug: string): Promise<GatewayServiceRow | null> {
  if (!GATEWAY_SLUG_RE.test(slug)) return null;
  const [row] = await systemDb
    .select()
    .from(gatewayServices)
    .where(eq(gatewayServices.slug, slug))
    .limit(1);
  return row ?? null;
}

const uuidOrNull = (v: string | null | undefined): string | null =>
  v && UUID_RE.test(v) ? v.toLowerCase() : null;

/** Register a service, or set every value of the one with its slug
 *  (checked values: checkGatewayService). At the full-route spot
 *  tool-config: a row decides where calls go. */
export async function saveGatewayService(
  values: GatewayServiceValues,
  by: string | null,
): Promise<{ row: GatewayServiceRow; created: boolean }> {
  const createdBy = uuidOrNull(by);
  return onFullSystemRoute('tool-config', async () => {
    const [row] = await systemDb
      .insert(gatewayServices)
      .values({ ...values, createdBy })
      .onConflictDoUpdate({
        target: gatewayServices.slug,
        set: { ...values, createdBy, updatedAt: new Date() },
      })
      .returning({ ...getTableColumns(gatewayServices), created: sql<boolean>`(xmax = 0)` });
    const { created, ...saved } = row!;
    return { row: saved, created };
  });
}

/** What a register or an edit may change: every field but the slug may be
 *  left out (an edit keeps it; a new service takes the default, and must
 *  name its upstream). */
export type GatewayServicePatch = Readonly<{
  name?: string;
  upstream?: string;
  pathPrefixes?: readonly string[];
  methods?: readonly string[];
  readsOnly?: boolean;
  enabled?: boolean;
  note?: string | null;
}>;

/** Register the service `slug`, or change the fields `patch` names of the
 *  one there: checked as a whole (checkGatewayService), then saved. */
export async function setGatewayService(
  slug: string,
  patch: GatewayServicePatch,
  by: string | null,
): Promise<{ ok: true; row: GatewayServiceRow; created: boolean } | { ok: false; error: string }> {
  const have = await getGatewayService(slug);
  if (!have && patch.upstream === undefined) {
    return {
      ok: false,
      error: `no service '${slug.slice(0, 40)}' is registered yet, so upstream is required: its host:port on mantle_services, e.g. 'billing-agent:8080'`,
    };
  }
  const checked = checkGatewayService({
    slug,
    name: patch.name ?? have?.name,
    upstream: patch.upstream ?? have!.upstream,
    pathPrefixes: patch.pathPrefixes ?? have?.pathPrefixes,
    methods: patch.methods ?? have?.methods,
    readsOnly: patch.readsOnly ?? have?.readsOnly,
    enabled: patch.enabled ?? have?.enabled,
    note: patch.note !== undefined ? patch.note : (have?.note ?? null),
  });
  if (!checked.ok) return checked;
  return { ok: true, ...(await saveGatewayService(checked.value, by)) };
}
