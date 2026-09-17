/**
 * @mantle/content — CRUD for the content surfaces: notes, tasks, events,
 * and pages. Notes/tasks/events store their payload in `nodes.data` (jsonb);
 * pages keep the TipTap document in a `pages` sidecar with a derived
 * plaintext rendering. All live under dedicated ltree roots and the
 * extractor picks them up via the `node_ingested` pg_notify trigger.
 *
 * Web + MCP both import from here so the assistant and the UI agree on
 * shape and validation.
 */

export * from './index-entries';
export * from './index-pages';
export * from './index-apps';
export * from './index-peers';
export * from './index-nodes';
export * from './index-misc';
export * from './index-tables';
export * from './index-team';
export * from './index-identity';
