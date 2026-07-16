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

/** One call in a recipe tool's chain. The named tool runs with `input`,
 *  whose string values may carry templates resolved at dispatch time:
 *  `{param}` pulls from the recipe call's own input, and `$0` / `$step.path`
 *  pulls a prior step's (optionally dotted-into) output. Data flows between
 *  steps server-side, so a body never crosses the LLM. */
export type RecipeStep = {
  /** slug of the tool this step calls */
  tool: string;
  /** input passed to the tool; string values support `{param}` + `$ref` templates */
  input?: Record<string, unknown>;
  /** name to reference this step's output as `$name`; defaults to its index (`$0`, `$1`, …) */
  as?: string;
};

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
  | { kind: 'shell'; cmd: string }
  | {
      /** A composition of existing tools. Steps run in order; each step's
       *  output is addressable by later steps (`$0`, `$name.path`). The
       *  recipe's output is `output` (resolved like a step input) when set,
       *  else the last step's output. Authored by agents (Toolsmith) to
       *  fill a capability gap without a code change — see recipe.ts for the
       *  executor + the safety envelope (no shell/confirm/privilege steps). */
      kind: 'recipe';
      steps: RecipeStep[];
      /** Optional output template; default = the last step's output. */
      output?: unknown;
    };

/**
 * One row per registered tool. Built-ins are seeded by the agent on boot;
 * user-defined tools (http/shell) get added via the UI / API later.
 */
export const tools = pgTable(
  'tools',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    inputSchema: jsonb('input_schema')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
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
