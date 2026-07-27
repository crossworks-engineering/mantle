import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * CLI sandboxes — persistent, isolated terminal environments the coder agent
 * works in (clone a repo, build a small service) via the `sandboxd` supervisor
 * sidecar. Infrastructure objects, NOT nodes: nothing here is embedded or
 * retrievable; per-command history lives in trace steps, keyed by sandbox id.
 *
 * The container is disposable; the WORK is not. Each sandbox owns a host
 * directory (`${SANDBOXES_DIR}/<id>/files`, bind-mounted at /files, the default
 * cwd), which survives `sandbox_rm` unless the owner explicitly purges it.
 * Rows are deleted on rm (freeing the name); the files dir and traces remain
 * the durable record.
 *
 * `network` is the egress tier chosen at creation: 'full' (internet via the
 * isolated mantle_sandbox bridge — never the app network), 'balanced'
 * (internal network; outbound only through sandboxd's allowlisting proxy —
 * registries/GitHub/apt by default), or 'none' (offline).
 */
export const sandboxStatus = pgEnum('sandbox_status', ['running', 'stopped']);
export const sandboxNetwork = pgEnum('sandbox_network', ['full', 'balanced', 'none']);

export const sandboxes = pgTable(
  'sandboxes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** Short handle the agent addresses the sandbox by, e.g. 'mantle-repo'. */
    name: text('name').notNull(),
    /** One-line, owner/agent-written purpose. Display only — never embedded. */
    description: text('description'),
    /** Container image the sandbox was created from, e.g. 'ubuntu:24.04'. */
    image: text('image').notNull(),
    status: sandboxStatus('status').notNull().default('running'),
    network: sandboxNetwork('network').notNull().default('full'),
    /** Docker container id, set once created. Reconciled against sandboxd. */
    containerId: text('container_id'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('sandboxes_owner_name_uq').on(t.ownerId, t.name),
    index('sandboxes_owner_idx').on(t.ownerId),
  ],
);

export type Sandbox = typeof sandboxes.$inferSelect;
export type NewSandbox = typeof sandboxes.$inferInsert;
