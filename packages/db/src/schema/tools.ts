import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Handler descriptor. Stored as jsonb because the shape varies by kind. */
export type ToolHandler =
  | { kind: 'builtin'; ref: string }
  | {
      kind: 'http';
      /** Request URL. May contain `{param}` placeholders filled (URL-encoded)
       *  from the tool-call input, and `{{secret:service/label}}` refs
       *  resolved from the encrypted api_keys vault at dispatch time. */
      url: string;
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      /** Header map. Values support `{param}` + `{{secret:…}}` templating. */
      headers?: Record<string, string>;
      /** Query-string map appended to the URL. Keys are literal; values
       *  support templating. */
      query?: Record<string, string>;
      /** Body template. `{param}` is replaced with the JSON encoding of the
       *  input value (strings arrive quoted — write `"q": {query}`, not
       *  `"q": "{query}"`). When absent, non-GET requests send the whole
       *  input object as JSON (legacy behavior). */
      body?: string | null;
      headersRef?: string | null;
      authRef?: string | null;
      timeoutMs?: number;
    }
  | { kind: 'shell'; cmd: string };

/**
 * One row per registered tool. Built-ins are seeded by the agent on boot;
 * user-defined tools (http/shell) get added via the UI / API later.
 */
export const tools = pgTable(
  'tools',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    handler: jsonb('handler').$type<ToolHandler>().notNull(),
    requiresConfirm: boolean('requires_confirm').default(false).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('tools_owner_slug_uq').on(t.ownerId, t.slug),
    index('tools_owner_idx').on(t.ownerId),
  ],
);

export type Tool = typeof tools.$inferSelect;
export type NewTool = typeof tools.$inferInsert;
