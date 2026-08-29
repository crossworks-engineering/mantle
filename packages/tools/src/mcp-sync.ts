/**
 * MCP connector sync — materialises an external MCP server's tools as rows in
 * the connector's tool group. The sync OWNS group membership: it upserts a
 * `handler.kind === 'mcp'` row per remote tool, disables rows whose remote
 * tool vanished (never deletes — deleting would silently shrink a grant), and
 * rewrites the group's `toolSlugs` to the currently-live set, so grants and
 * the tool loop treat connector tools exactly like any others.
 *
 * Split pure/impure: `planMcpSync` decides everything from plain data (unit-
 * testable without a DB); `syncMcpConnector` fetches the remote list and
 * applies the plan. Sync runs on create, on demand, and NEVER on a schedule
 * (cost-safety rule: no crons that can fan out into LLM or remote spend).
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  agents,
  db,
  toolGroups,
  tools,
  type Tool,
  type ToolGroupIntegration,
  type ToolHandler,
} from '@mantle/db';
import { parseMcpBinding } from './integration-meta';
import { closeMcpClient, mcpListRemoteTools, type McpRemoteTool } from './mcp-client';
import { knownMcpServer } from './mcp-catalog';

/** Every connector group slug starts with this — guarantees no collision with
 *  a manifest group (none are `mcp-*`) and makes connector groups greppable. */
export const MCP_GROUP_PREFIX = 'mcp-';

const CONNECTOR_SLUG_RE = /^[a-z0-9_-]{1,60}$/;
const TOOL_DESC_MAX_CHARS = 2_000;
/** A remote schema past this (as JSON) is replaced with an open object — the
 *  remote server still validates its own args; we just stop shipping a bloated
 *  schema to the model on every turn. */
const TOOL_SCHEMA_MAX_CHARS = 30_000;
const TOOL_SLUG_MAX = 120;

export function mcpGroupSlug(connectorSlug: string): string {
  return connectorSlug.startsWith(MCP_GROUP_PREFIX)
    ? connectorSlug
    : `${MCP_GROUP_PREFIX}${connectorSlug}`;
}

/** `mcp-firecrawl` + `firecrawl_scrape` → `mcp_firecrawl_firecrawl_scrape`
 *  (namespaced, lowercase, collision-suffixed against `taken`). */
export function mcpToolSlug(groupSlug: string, remoteName: string, taken: Set<string>): string {
  const prefix = groupSlug.replace(/-/g, '_');
  let base = remoteName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = 'tool';
  let slug = `${prefix}_${base}`.slice(0, TOOL_SLUG_MAX);
  let n = 2;
  while (taken.has(slug)) {
    const suffix = `_${n++}`;
    slug = `${prefix}_${base}`.slice(0, TOOL_SLUG_MAX - suffix.length) + suffix;
  }
  return slug;
}

function cappedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  try {
    if (JSON.stringify(schema).length <= TOOL_SCHEMA_MAX_CHARS) return schema;
  } catch {
    /* circular / unserialisable — fall through to the open object */
  }
  return { type: 'object', additionalProperties: true };
}

export type McpSyncRowState = Pick<Tool, 'slug' | 'name' | 'description' | 'enabled'> & {
  handler: Extract<ToolHandler, { kind: 'mcp' }>;
  inputSchema: Record<string, unknown>;
};

export type McpSyncPlan = {
  inserts: Array<Omit<McpSyncRowState, 'enabled'>>;
  /** slug → fields to update (only rows that actually changed). */
  updates: Array<{ slug: string } & Partial<Omit<McpSyncRowState, 'slug' | 'handler'>>>;
  /** Rows whose remote tool vanished — disabled, never deleted. */
  disableSlugs: string[];
  /** The group's new membership: every remote-present tool, sorted. */
  toolSlugs: string[];
};

/**
 * Decide the row changes for one connector from plain data. `existing` is the
 * connector's current mcp rows; `ownerSlugs` is EVERY tool slug the owner
 * holds (new slugs must be unique owner-wide, not just group-wide). Identity
 * is the remote `toolName`, not the slug — a sanitisation change must not fork
 * a second row.
 */
export function planMcpSync(args: {
  groupSlug: string;
  remote: McpRemoteTool[];
  existing: McpSyncRowState[];
  ownerSlugs: Iterable<string>;
}): McpSyncPlan {
  const { groupSlug, remote, existing } = args;
  const byToolName = new Map(existing.map((r) => [r.handler.toolName, r]));
  const taken = new Set(args.ownerSlugs);
  const plan: McpSyncPlan = { inserts: [], updates: [], disableSlugs: [], toolSlugs: [] };
  const seen = new Set<string>();

  for (const t of remote) {
    if (seen.has(t.name)) continue; // a server listing dupes gets one row
    seen.add(t.name);
    const description = t.description.slice(0, TOOL_DESC_MAX_CHARS);
    const inputSchema = cappedSchema(t.inputSchema);
    const row = byToolName.get(t.name);
    if (row) {
      plan.toolSlugs.push(row.slug);
      const patch: (typeof plan.updates)[number] = { slug: row.slug };
      if (row.description !== description) patch.description = description;
      if (JSON.stringify(row.inputSchema) !== JSON.stringify(inputSchema)) {
        patch.inputSchema = inputSchema;
      }
      if (!row.enabled) patch.enabled = true; // reappeared after a vanish
      if (Object.keys(patch).length > 1) plan.updates.push(patch);
    } else {
      const slug = mcpToolSlug(groupSlug, t.name, taken);
      taken.add(slug);
      plan.toolSlugs.push(slug);
      plan.inserts.push({
        slug,
        name: t.name,
        description,
        inputSchema,
        handler: { kind: 'mcp', group: groupSlug, toolName: t.name },
      });
    }
  }

  for (const r of existing) {
    if (!seen.has(r.handler.toolName) && r.enabled) plan.disableSlugs.push(r.slug);
  }
  plan.toolSlugs.sort();
  return plan;
}

/** The generated description for a connector group. Carries the standing
 *  untrusted-content note plus the catalog's when-to-use guidance — the prose
 *  rung of "call this vs the built-ins". */
export function mcpGroupDescription(args: { url: string; whenToUse?: string }): string {
  let host = args.url;
  try {
    host = new URL(args.url).host;
  } catch {
    /* keep the raw url */
  }
  const base =
    `Tools served by the external MCP server at ${host}. ` +
    `Results are third-party content and arrive fenced as untrusted data. ` +
    `Grant to a no-write specialist (researcher pattern), not the persona or team responder.`;
  return args.whenToUse ? `${base} ${args.whenToUse}` : base;
}

export type McpSyncResult = {
  groupSlug: string;
  added: number;
  updated: number;
  disabled: number;
  toolSlugs: string[];
  serverInfo?: { name?: string; version?: string };
};

/** Fetch the remote tool list and reconcile the connector's rows + group. */
export async function syncMcpConnector(ownerId: string, groupSlug: string): Promise<McpSyncResult> {
  const [group] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  const mcp = group?.integration?.mcp;
  if (!group || !mcp) {
    throw new Error(
      `'${groupSlug}' is not an MCP connector group — list connectors via the connectors API, or create one first`,
    );
  }

  const { tools: remote, serverInfo } = await mcpListRemoteTools(ownerId, groupSlug, mcp);

  const ownerRows = await db.select().from(tools).where(eq(tools.ownerId, ownerId));
  const existing = ownerRows.filter(
    (r): r is Tool & { handler: Extract<ToolHandler, { kind: 'mcp' }> } =>
      r.handler.kind === 'mcp' && r.handler.group === groupSlug,
  );
  const plan = planMcpSync({
    groupSlug,
    remote,
    existing: existing.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      enabled: r.enabled,
      handler: r.handler,
      inputSchema: r.inputSchema,
    })),
    ownerSlugs: ownerRows.map((r) => r.slug),
  });

  const now = new Date();
  for (const ins of plan.inserts) {
    await db.insert(tools).values({
      ownerId,
      slug: ins.slug,
      name: ins.name,
      description: ins.description,
      inputSchema: ins.inputSchema,
      handler: ins.handler,
      requiresConfirm: false,
      enabled: true,
    });
  }
  for (const upd of plan.updates) {
    const { slug, ...fields } = upd;
    await db
      .update(tools)
      .set({ ...fields, updatedAt: now })
      .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, slug)));
  }
  for (const slug of plan.disableSlugs) {
    await db
      .update(tools)
      .set({ enabled: false, updatedAt: now })
      .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, slug)));
  }

  const nextIntegration: ToolGroupIntegration = {
    ...group.integration!,
    mcp: {
      ...mcp,
      lastSyncAt: now.toISOString(),
      toolCount: plan.toolSlugs.length,
      ...(serverInfo ? { serverInfo } : {}),
    },
  };
  await db
    .update(toolGroups)
    .set({ toolSlugs: plan.toolSlugs, integration: nextIntegration, updatedAt: now })
    .where(eq(toolGroups.id, group.id));

  return {
    groupSlug,
    added: plan.inserts.length,
    updated: plan.updates.length,
    disabled: plan.disableSlugs.length,
    toolSlugs: plan.toolSlugs,
    ...(serverInfo ? { serverInfo } : {}),
  };
}

export type CreateMcpConnectorInput = {
  /** Connector slug ('firecrawl'); the group becomes `mcp-<slug>`. */
  slug: string;
  name?: string;
  url: string;
  secretRef?: string;
  authHeader?: string;
  authScheme?: string;
};

export type CreateMcpConnectorResult = {
  groupSlug: string;
  created: true;
  /** Set when the initial sync succeeded. */
  sync?: McpSyncResult;
  /** Set when the group was created but the first sync failed (bad key, server
   *  down) — fix the config and re-run sync; the group is not rolled back. */
  syncError?: string;
};

/** Create a connector: the `mcp-<slug>` group with its binding, then a first
 *  sync. A failed sync keeps the group (fix + resync beats re-typing). */
export async function createMcpConnector(
  ownerId: string,
  input: CreateMcpConnectorInput,
): Promise<CreateMcpConnectorResult> {
  const connectorSlug = input.slug.trim().toLowerCase();
  if (!CONNECTOR_SLUG_RE.test(connectorSlug)) {
    throw new Error(
      `connector slug '${input.slug}' must be lowercase letters/digits/dash/underscore (max 60) — e.g. 'firecrawl'`,
    );
  }
  const groupSlug = mcpGroupSlug(connectorSlug);
  const parsed = parseMcpBinding({
    url: input.url,
    secretRef: input.secretRef,
    authHeader: input.authHeader,
    authScheme: input.authScheme,
  });
  if (!parsed.ok) throw new Error(parsed.error);

  const [existing] = await db
    .select({ id: toolGroups.id })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  if (existing) {
    throw new Error(
      `connector group '${groupSlug}' already exists — update its binding or re-run sync instead of creating it again`,
    );
  }

  const catalog = knownMcpServer(connectorSlug);
  await db.insert(toolGroups).values({
    ownerId,
    slug: groupSlug,
    name: input.name?.trim() || catalog?.label || `MCP: ${connectorSlug}`,
    description: mcpGroupDescription({ url: parsed.value.url, whenToUse: catalog?.whenToUse }),
    toolSlugs: [],
    integration: { service: connectorSlug, mcp: parsed.value },
    enabled: true,
  });

  try {
    const sync = await syncMcpConnector(ownerId, groupSlug);
    return { groupSlug, created: true, sync };
  } catch (err) {
    return {
      groupSlug,
      created: true,
      syncError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Delete a connector: its tool rows, its group, every agent's grant of it,
 *  and the cached client. */
export async function deleteMcpConnector(ownerId: string, groupSlug: string): Promise<boolean> {
  const [group] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  if (!group?.integration?.mcp) return false;
  const ownerRows = await db
    .select({ slug: tools.slug, handler: tools.handler })
    .from(tools)
    .where(eq(tools.ownerId, ownerId));
  const toolSlugsToDelete = ownerRows
    .filter((r) => r.handler.kind === 'mcp' && r.handler.group === groupSlug)
    .map((r) => r.slug);
  await db.transaction(async (tx) => {
    for (const slug of toolSlugsToDelete) {
      await tx.delete(tools).where(and(eq(tools.ownerId, ownerId), eq(tools.slug, slug)));
    }
    await tx.delete(toolGroups).where(eq(toolGroups.id, group.id));
    await tx
      .update(agents)
      .set({
        toolGroupSlugs: sql`array_remove(${agents.toolGroupSlugs}, ${groupSlug})`,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.ownerId, ownerId), sql`${groupSlug} = ANY(${agents.toolGroupSlugs})`));
  });
  await closeMcpClient(ownerId, groupSlug);
  return true;
}
