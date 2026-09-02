/**
 * OpenAPI connector sync — fetches a service's OpenAPI 3.x spec and
 * materialises its selected operations as ORDINARY `http` tool rows inside
 * the connector's tool group (provenance on `handler.openapi`). The mcp-sync
 * sibling, deliberately: the sync OWNS group membership, disables rows whose
 * operation vanished or was deselected (never deletes; `vanishedAt` marks a
 * sync-disable so an OWNER disable is never overridden), and rewrites the
 * group's `toolSlugs` to the live enabled set.
 *
 * One deliberate difference from mcp: hand-EDITS of a synced tool survive.
 * The crud layer stamps `handler.openapi.editedAt` when a definition is
 * edited; the sync then leaves that row alone (reported, not overwritten)
 * unless the caller passes `overwriteEdited`.
 *
 * Split pure/impure: `planOpenapiSync` decides everything from plain data;
 * `syncOpenapiConnector` fetches + compiles + applies. Sync runs on create
 * and on demand, NEVER on a schedule (cost-safety rule).
 */

import { createHash } from 'node:crypto';
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
import { parseIntegrationMeta, parseOpenapiBinding } from './integration-meta';
import { safeFetch } from './safe-fetch';
import type { HttpHandler } from './http-template';
import {
  compileOperations,
  extractInventory,
  OPENAPI_SPEC_MAX_BYTES,
  OPENAPI_TOOL_HARD_CAP,
  OPENAPI_TOOL_WARN_THRESHOLD,
  parseOpenapiDocument,
  type CompiledOperation,
  type SpecInventory,
} from './openapi-spec';
import { knownOpenapiApi } from './openapi-catalog';
import { errorMessage } from '@mantle/std';

/** Every OpenAPI connector group slug starts with this. NOT `api-`: that is
 *  the usage-skill naming convention (`apiSkillSlugForGroup`), and reusing it
 *  would make skill and group names read as each other. No manifest group is
 *  `openapi-*`, so a collision with the template is impossible. */
export const OPENAPI_GROUP_PREFIX = 'openapi-';

const CONNECTOR_SLUG_RE = /^[a-z0-9_-]{1,60}$/;
const TOOL_SLUG_MAX = 120;

export function openapiGroupSlug(connectorSlug: string): string {
  return connectorSlug.startsWith(OPENAPI_GROUP_PREFIX)
    ? connectorSlug
    : `${OPENAPI_GROUP_PREFIX}${connectorSlug}`;
}

/** `openapi-petstore` + `getPetById` → `openapi_petstore_getpetbyid`
 *  (namespaced, lowercase, collision-suffixed against `taken`). */
export function openapiToolSlug(groupSlug: string, opKey: string, taken: Set<string>): string {
  const prefix = groupSlug.replace(/-/g, '_');
  let base = opKey
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = 'op';
  let slug = `${prefix}_${base}`.slice(0, TOOL_SLUG_MAX);
  let n = 2;
  while (taken.has(slug)) {
    const suffix = `_${n++}`;
    slug = `${prefix}_${base}`.slice(0, TOOL_SLUG_MAX - suffix.length) + suffix;
  }
  return slug;
}

export type OpenapiMirrorHandler = HttpHandler & {
  openapi: NonNullable<HttpHandler['openapi']>;
};

/** True for a row materialised by an OpenAPI connector's sync. */
export function isOpenapiMirrorHandler(h: ToolHandler): h is OpenapiMirrorHandler {
  return h.kind === 'http' && !!h.openapi;
}

export type OpenapiSyncRowState = Pick<Tool, 'slug' | 'name' | 'description' | 'enabled'> & {
  handler: OpenapiMirrorHandler;
  inputSchema: Record<string, unknown>;
};

export type OpenapiSyncPlan = {
  inserts: Array<Omit<OpenapiSyncRowState, 'enabled'>>;
  /** slug → fields to update (only rows that actually changed). */
  updates: Array<{ slug: string } & Partial<Omit<OpenapiSyncRowState, 'slug'>>>;
  /** Rows whose operation vanished or was deselected — disabled + marked. */
  disables: Array<{ slug: string; handler: OpenapiMirrorHandler }>;
  /** Hand-edited rows the sync left alone (pass overwriteEdited to reclaim). */
  keptEdited: string[];
  /** The group's new membership: enabled, spec-present, selected rows, sorted. */
  toolSlugs: string[];
};

/**
 * Decide the row changes for one connector from plain data. Identity is
 * `handler.openapi.op` (operationId, else 'method /path'), never the slug.
 *
 * Disable/re-enable is asymmetric exactly like mcp: only rows the SYNC
 * disabled (marked `openapi.vanishedAt`) auto-re-enable when the operation
 * returns; an owner-disabled row stays off and out of membership. A row with
 * `openapi.editedAt` keeps its stored definition (the edit survives re-sync)
 * unless `overwriteEdited` restores the compiled version and clears the stamp.
 */
export function planOpenapiSync(args: {
  groupSlug: string;
  compiled: CompiledOperation[];
  existing: OpenapiSyncRowState[];
  ownerSlugs: Iterable<string>;
  overwriteEdited?: boolean;
  /** Timestamp stamped onto vanish markers; injectable for tests. */
  now?: string;
}): OpenapiSyncPlan {
  const { groupSlug, compiled, existing } = args;
  const now = args.now ?? new Date().toISOString();
  const byOp = new Map(existing.map((r) => [r.handler.openapi.op, r]));
  const taken = new Set(args.ownerSlugs);
  const plan: OpenapiSyncPlan = {
    inserts: [],
    updates: [],
    disables: [],
    keptEdited: [],
    toolSlugs: [],
  };
  const seen = new Set<string>();

  for (const c of compiled) {
    if (seen.has(c.op)) continue; // a spec listing dupes gets one row
    seen.add(c.op);
    const row = byOp.get(c.op);
    if (!row) {
      const slug = openapiToolSlug(groupSlug, c.op, taken);
      taken.add(slug);
      plan.toolSlugs.push(slug);
      plan.inserts.push({
        slug,
        name: c.name,
        description: c.description,
        inputSchema: c.inputSchema,
        handler: { ...c.handler, openapi: { group: groupSlug, op: c.op } },
      });
      continue;
    }
    const syncDisabled = !row.enabled && !!row.handler.openapi.vanishedAt;
    const ownerDisabled = !row.enabled && !row.handler.openapi.vanishedAt;
    const edited = !!row.handler.openapi.editedAt && !args.overwriteEdited;
    const patch: (typeof plan.updates)[number] = { slug: row.slug };

    if (edited) {
      plan.keptEdited.push(row.slug);
      if (syncDisabled) {
        // Returned after a vanish WE recorded — restore, keeping the edit.
        const { vanishedAt: _dropped, ...restProv } = row.handler.openapi;
        patch.enabled = true;
        patch.handler = { ...row.handler, openapi: restProv };
      }
    } else {
      const fresh: OpenapiMirrorHandler = {
        ...c.handler,
        openapi: { group: groupSlug, op: c.op },
      };
      if (row.name !== c.name) patch.name = c.name;
      if (row.description !== c.description) patch.description = c.description;
      if (JSON.stringify(row.inputSchema) !== JSON.stringify(c.inputSchema)) {
        patch.inputSchema = c.inputSchema;
      }
      const current = syncDisabled
        ? { ...row.handler, openapi: dropKeys(row.handler.openapi, ['vanishedAt']) }
        : row.handler;
      if (JSON.stringify(current) !== JSON.stringify(fresh)) patch.handler = fresh;
      if (syncDisabled) {
        patch.enabled = true;
        if (patch.handler === undefined) patch.handler = fresh;
      }
    }
    if (Object.keys(patch).length > 1) plan.updates.push(patch);
    if (!ownerDisabled) plan.toolSlugs.push(row.slug);
  }

  for (const r of existing) {
    if (!seen.has(r.handler.openapi.op) && r.enabled) {
      plan.disables.push({
        slug: r.slug,
        handler: { ...r.handler, openapi: { ...r.handler.openapi, vanishedAt: now } },
      });
    }
  }
  plan.toolSlugs.sort();
  return plan;
}

function dropKeys<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/** The generated description for a connector group. Carries the standing
 *  untrusted-source note plus the catalog's when-to-use guidance. */
export function openapiGroupDescription(args: {
  specUrl: string;
  apiTitle?: string;
  whenToUse?: string;
}): string {
  let host = args.specUrl;
  try {
    host = new URL(args.specUrl).host;
  } catch {
    /* keep the raw url */
  }
  const what = args.apiTitle ? `the ${args.apiTitle}` : `the API described at ${host}`;
  const base =
    `HTTP tools compiled from ${what}'s OpenAPI spec. ` +
    `Descriptions come from the spec (third-party text) and responses are external data. ` +
    `Grant to a no-write specialist (researcher pattern) rather than the persona or team responder.`;
  return args.whenToUse ? `${base} ${args.whenToUse}` : base;
}

/* ───────────────────────────── spec fetch ───────────────────────────── */

/** Fetch the raw spec text through the SSRF-guarded fetch with a hard byte
 *  cap, and hash it for change visibility. */
export async function fetchSpecText(specUrl: string): Promise<{ text: string; hash: string }> {
  const res = await safeFetch(specUrl, { method: 'GET' }, []);
  if (!res.ok) {
    throw new Error(
      `fetching the spec failed with HTTP ${res.status} — check the spec URL serves the raw OpenAPI document (not a docs page) and needs no authentication`,
    );
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > OPENAPI_SPEC_MAX_BYTES) throw specTooLarge();
    return { text, hash: sha256(text) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OPENAPI_SPEC_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw specTooLarge();
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { text, hash: sha256(text) };
}

function specTooLarge(): Error {
  return new Error(
    `the spec exceeds the ${Math.round(OPENAPI_SPEC_MAX_BYTES / 1024 / 1024)} MB cap — point the connector at a trimmed or per-section spec (many large APIs publish one per product area)`,
  );
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ─────────────────────────────── preview ────────────────────────────── */

export type OpenapiPreview = SpecInventory & { suggestedBaseUrl?: string };

/** Fetch + parse a spec WITHOUT creating anything — the pick step. The
 *  inventory (tags with counts, operations with summaries) is what a UI or
 *  Toolsmith uses to build `selection` before the connector exists. */
export async function previewOpenapiSpec(specUrl: string): Promise<OpenapiPreview> {
  const { text } = await fetchSpecText(specUrl);
  const parsed = parseOpenapiDocument(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const inventory = extractInventory(parsed.doc);
  return {
    ...inventory,
    ...(inventory.servers[0] ? { suggestedBaseUrl: inventory.servers[0] } : {}),
  };
}

/* ──────────────────────────────── sync ──────────────────────────────── */

export type OpenapiSyncResult = {
  groupSlug: string;
  added: number;
  updated: number;
  disabled: number;
  keptEdited: string[];
  toolSlugs: string[];
  warnings: string[];
  apiTitle?: string;
  apiVersion?: string;
  /** Operations in the spec vs after selection. */
  operationsTotal: number;
  selectedCount: number;
};

/** Fetch the spec, compile the selected operations, and reconcile the
 *  connector's rows + group. */
export async function syncOpenapiConnector(
  ownerId: string,
  groupSlug: string,
  opts?: { overwriteEdited?: boolean },
): Promise<OpenapiSyncResult> {
  const [group] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  const binding = group?.integration?.openapi;
  if (!group || !binding) {
    throw new Error(
      `'${groupSlug}' is not an OpenAPI connector group — list connectors via the openapi-connectors API, or create one first`,
    );
  }

  const { text, hash } = await fetchSpecText(binding.specUrl);
  const parsed = parseOpenapiDocument(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const inventory = extractInventory(parsed.doc);

  // Adopt a base URL from the spec's root servers only while the group has
  // none — once set (by us or the owner) a spec change never moves it.
  let integration: ToolGroupIntegration = group.integration!;
  let adoptedBaseUrl: string | undefined;
  if (!integration.baseUrl && inventory.servers[0]) {
    adoptedBaseUrl = inventory.servers[0];
    integration = { ...integration, baseUrl: adoptedBaseUrl };
  }

  const compiled = compileOperations(parsed.doc, {
    integration,
    selection: binding.selection,
  });
  if (!compiled.ok) throw new Error(compiled.error);
  if (compiled.tools.length > OPENAPI_TOOL_HARD_CAP) {
    throw new Error(
      `the selection matches ${compiled.tools.length} operations, over the ${OPENAPI_TOOL_HARD_CAP}-tool cap — every tool description is paid for in the prompt on every turn. Narrow integration.openapi.selection (tags and/or operations; use the preview endpoint to list them), then re-sync`,
    );
  }

  const warnings = [...compiled.warnings];
  if (adoptedBaseUrl) {
    warnings.push(
      `base_url '${adoptedBaseUrl}' adopted from the spec's servers list — override it on the connector if the API lives elsewhere`,
    );
  }
  if (compiled.specDeclaresSecurity && !integration.authTemplate) {
    warnings.push(
      'the spec declares authentication but the group has no auth_template — set secret_ref + auth_template on the connector or calls will go out unauthenticated',
    );
  }
  if (compiled.tools.length > OPENAPI_TOOL_WARN_THRESHOLD) {
    warnings.push(
      `${compiled.tools.length} tools is context-heavy — consider narrowing the selection to the operations agents will actually use`,
    );
  }

  const ownerRows = await db.select().from(tools).where(eq(tools.ownerId, ownerId));
  const existing = ownerRows
    .filter((r) => isOpenapiMirrorHandler(r.handler) && r.handler.openapi.group === groupSlug)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      enabled: r.enabled,
      handler: r.handler as OpenapiMirrorHandler,
      inputSchema: r.inputSchema,
    }));
  const plan = planOpenapiSync({
    groupSlug,
    compiled: compiled.tools,
    existing,
    ownerSlugs: ownerRows.map((r) => r.slug),
    overwriteEdited: opts?.overwriteEdited,
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
  for (const d of plan.disables) {
    await db
      .update(tools)
      .set({ enabled: false, handler: d.handler, updatedAt: now })
      .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, d.slug)));
  }

  const nextIntegration: ToolGroupIntegration = {
    ...integration,
    openapi: {
      ...binding,
      specHash: hash,
      ...(inventory.title ? { apiTitle: inventory.title } : {}),
      ...(inventory.version ? { apiVersion: inventory.version } : {}),
      lastSyncAt: now.toISOString(),
      toolCount: plan.toolSlugs.length,
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
    disabled: plan.disables.length,
    keptEdited: plan.keptEdited,
    toolSlugs: plan.toolSlugs,
    warnings,
    ...(inventory.title ? { apiTitle: inventory.title } : {}),
    ...(inventory.version ? { apiVersion: inventory.version } : {}),
    operationsTotal: compiled.operationsTotal,
    selectedCount: compiled.tools.length,
  };
}

/* ─────────────────────────── create / delete ────────────────────────── */

export type CreateOpenapiConnectorInput = {
  /** Connector slug ('petstore'); the group becomes `openapi-<slug>`. */
  slug: string;
  name?: string;
  specUrl: string;
  /** Vendor key for the integration; defaults to the connector slug. */
  service?: string;
  baseUrl?: string;
  secretRef?: string;
  authTemplate?: { headers?: Record<string, string>; query?: Record<string, string> };
  selection?: { tags?: string[]; operations?: string[] };
};

export type CreateOpenapiConnectorResult = {
  groupSlug: string;
  created: true;
  warnings: string[];
  /** Set when the initial sync succeeded. */
  sync?: OpenapiSyncResult;
  /** Set when the group was created but the first sync failed (spec down,
   *  over-cap selection) — fix the config and re-run sync; not rolled back. */
  syncError?: string;
};

/** Create a connector: the `openapi-<slug>` group with its binding, then a
 *  first sync. A failed sync keeps the group (fix + resync beats re-typing). */
export async function createOpenapiConnector(
  ownerId: string,
  input: CreateOpenapiConnectorInput,
): Promise<CreateOpenapiConnectorResult> {
  const connectorSlug = input.slug.trim().toLowerCase();
  if (!CONNECTOR_SLUG_RE.test(connectorSlug)) {
    throw new Error(
      `connector slug '${input.slug}' must be lowercase letters/digits/dash/underscore (max 60) — e.g. 'petstore'`,
    );
  }
  const groupSlug = openapiGroupSlug(connectorSlug);
  const catalog = knownOpenapiApi(connectorSlug);

  const parsedBinding = parseOpenapiBinding({
    specUrl: input.specUrl,
    ...(input.selection ? { selection: input.selection } : {}),
  });
  if (!parsedBinding.ok) throw new Error(parsedBinding.error);

  const meta = parseIntegrationMeta({
    service: input.service?.trim() || connectorSlug,
    ...((input.baseUrl ?? catalog?.baseUrl) ? { baseUrl: input.baseUrl ?? catalog?.baseUrl } : {}),
    ...(input.secretRef ? { secretRef: input.secretRef } : {}),
    ...(input.authTemplate ? { authTemplate: input.authTemplate } : {}),
    openapi: parsedBinding.value,
  });
  if (!meta.ok) throw new Error(meta.error);

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

  await db.insert(toolGroups).values({
    ownerId,
    slug: groupSlug,
    name: input.name?.trim() || catalog?.label || `API: ${connectorSlug}`,
    description: openapiGroupDescription({
      specUrl: parsedBinding.value.specUrl,
      whenToUse: catalog?.whenToUse,
    }),
    toolSlugs: [],
    integration: meta.value,
    enabled: true,
  });

  try {
    const sync = await syncOpenapiConnector(ownerId, groupSlug);
    return { groupSlug, created: true, warnings: meta.warnings, sync };
  } catch (err) {
    return {
      groupSlug,
      created: true,
      warnings: meta.warnings,
      syncError: errorMessage(err),
    };
  }
}

/** Delete a connector: its mirrored tool rows, its group, and every agent's
 *  grant of it. Nothing else to purge (no sealed OAuth state on this kind). */
export async function deleteOpenapiConnector(ownerId: string, groupSlug: string): Promise<boolean> {
  const [group] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  if (!group?.integration?.openapi) return false;
  const ownerRows = await db
    .select({ slug: tools.slug, handler: tools.handler })
    .from(tools)
    .where(eq(tools.ownerId, ownerId));
  const toolSlugsToDelete = ownerRows
    .filter((r) => isOpenapiMirrorHandler(r.handler) && r.handler.openapi.group === groupSlug)
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
  return true;
}
