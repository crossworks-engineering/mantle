import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';

/**
 * The services the service gateway may route to (migration 0358;
 * docs/gateway.md). The gateway (server/gateway) answers
 * `/svc/<slug>/<path>` only for an enabled row here, only with a method in
 * `methods` and a path under one of `pathPrefixes`, and sends it to
 * `upstream` (`host:port` on the internal network mantle_services).
 *
 * `readsOnly` is the owner's mark of what the service does: shown, never
 * relied on (an MCP service reads over POST; the service's own login
 * decides what it may change). Written by an Admin user with the connectors
 * area (at the full-route spot tool-config), read on the system pool.
 */
export const gatewayServices = pgTable(
  'gateway_services',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    upstream: text('upstream').notNull(),
    pathPrefixes: text('path_prefixes')
      .array()
      .notNull()
      .default(sql`'{/}'::text[]`),
    methods: text('methods')
      .array()
      .notNull()
      .default(sql`'{GET}'::text[]`),
    readsOnly: boolean('reads_only').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    note: text('note'),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('gateway_services_slug_uq').on(t.slug)],
);

export type GatewayServiceRow = typeof gatewayServices.$inferSelect;

/**
 * The gateway's call log (migration 0358): one row per call it answered or
 * refused. `serviceSlug` is the slug asked for (an unknown one too), `path`
 * the path below the slug without its query string, `refusal` the fixed
 * code of a refusal (null for a call it sent on). `caller` and `loginId`
 * are what the brain named in its request (an agent, a login, a connector).
 * Written by the gateway only; it removes rows past 90 days itself.
 */
export const gatewayCalls = pgTable(
  'gateway_calls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    serviceSlug: text('service_slug').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    requestBytes: bigint('request_bytes', { mode: 'number' }).notNull().default(0),
    responseBytes: bigint('response_bytes', { mode: 'number' }).notNull().default(0),
    durationMs: integer('duration_ms').notNull(),
    caller: text('caller'),
    loginId: uuid('login_id'),
    refusal: text('refusal'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('gateway_calls_created_idx').on(t.createdAt),
    index('gateway_calls_slug_created_idx').on(t.serviceSlug, t.createdAt.desc()),
  ],
);

export type GatewayCallRow = typeof gatewayCalls.$inferSelect;
