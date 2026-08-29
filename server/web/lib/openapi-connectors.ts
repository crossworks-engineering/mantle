/**
 * Server-side helpers for OpenAPI connectors — thin wrappers over the engine
 * in @mantle/tools (openapi-sync.ts / openapi-spec.ts). A connector IS a
 * `tool_groups` row whose `integration.openapi` binds a service's spec; the
 * mcp-connectors sibling of this file, minus OAuth (auth rides the ordinary
 * integration fields and the vault). These helpers add the API-facing
 * composition: listing with grant fan-out, the known-APIs catalog with
 * configured flags, and binding edits.
 */

import { and, eq } from 'drizzle-orm';
import { db, toolGroups, type ToolGroup, type ToolGroupIntegration } from '@mantle/db';
import {
  KNOWN_OPENAPI_APIS,
  openapiGroupSlug,
  parseIntegrationMeta,
  parseOpenapiBinding,
  type KnownOpenapiApi,
} from '@mantle/tools';
import { listToolGroupBackrefs } from '@/lib/tool-groups';
import type { ToolGroupDTO } from '@mantle/client-types';

export type OpenapiConnectorSummary = ToolGroupDTO & { grantedTo: string[] };

function toDTO(g: ToolGroup, grantedTo: string[]): OpenapiConnectorSummary {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    description: g.description,
    toolSlugs: g.toolSlugs ?? [],
    integration: g.integration ?? null,
    enabled: g.enabled,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    grantedTo,
  };
}

export async function listOpenapiConnectors(ownerId: string): Promise<{
  connectors: OpenapiConnectorSummary[];
  catalog: Array<KnownOpenapiApi & { connected: boolean }>;
}> {
  const [rows, backrefs] = await Promise.all([
    db.select().from(toolGroups).where(eq(toolGroups.ownerId, ownerId)),
    listToolGroupBackrefs(ownerId),
  ]);
  const connectors = rows
    .filter((g) => g.integration?.openapi)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((g) => toDTO(g, backrefs.get(g.slug) ?? []));
  const have = new Set(connectors.map((c) => c.slug));
  const catalog = KNOWN_OPENAPI_APIS.map((s) => ({
    ...s,
    connected: have.has(openapiGroupSlug(s.slug)),
  }));
  return { connectors, catalog };
}

export async function getOpenapiConnector(
  ownerId: string,
  groupSlug: string,
): Promise<OpenapiConnectorSummary | null> {
  const [row] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  if (!row?.integration?.openapi) return null;
  const backrefs = await listToolGroupBackrefs(ownerId);
  return toDTO(row, backrefs.get(row.slug) ?? []);
}

export type UpdateOpenapiConnectorInput = {
  name?: string;
  enabled?: boolean;
  specUrl?: string;
  /** '' clears the base URL (the next sync re-adopts from the spec). */
  baseUrl?: string;
  /** '' clears the credential. */
  secretRef?: string;
  /** null clears the auth placement. */
  authTemplate?: { headers?: Record<string, string>; query?: Record<string, string> } | null;
  /** null clears the selection (ALL operations — only legal under the cap). */
  selection?: { tags?: string[]; operations?: string[] } | null;
};

/** Patch a connector's binding/name/enabled. Binding changes take effect on
 *  the next sync (nothing is cached per connector on this kind). Returns a
 *  teaching error string instead of throwing on invalid input. */
export async function updateOpenapiConnector(
  ownerId: string,
  groupSlug: string,
  patch: UpdateOpenapiConnectorInput,
): Promise<
  { connector: OpenapiConnectorSummary; warnings: string[] } | { error: string; status: number }
> {
  const [row] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  const binding = row?.integration?.openapi;
  if (!row || !binding) {
    return { error: `OpenAPI connector '${groupSlug}' not found`, status: 404 };
  }

  const bindingTouched =
    patch.specUrl !== undefined ||
    patch.baseUrl !== undefined ||
    patch.secretRef !== undefined ||
    patch.authTemplate !== undefined ||
    patch.selection !== undefined;

  let nextIntegration: ToolGroupIntegration = row.integration!;
  const warnings: string[] = [];
  if (bindingTouched) {
    const nextBinding = parseOpenapiBinding({
      ...binding,
      ...(patch.specUrl !== undefined ? { specUrl: patch.specUrl } : {}),
      ...(patch.selection !== undefined
        ? { selection: patch.selection === null ? undefined : patch.selection }
        : {}),
    });
    if (!nextBinding.ok) return { error: nextBinding.error, status: 400 };

    const merged: Record<string, unknown> = {
      ...row.integration,
      openapi: nextBinding.value,
    };
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl === '') delete merged.baseUrl;
      else merged.baseUrl = patch.baseUrl;
    }
    if (patch.secretRef !== undefined) {
      if (patch.secretRef === '') delete merged.secretRef;
      else merged.secretRef = patch.secretRef;
    }
    if (patch.authTemplate !== undefined) {
      if (patch.authTemplate === null) delete merged.authTemplate;
      else merged.authTemplate = patch.authTemplate;
    }
    const meta = parseIntegrationMeta(merged);
    if (!meta.ok) return { error: meta.error, status: 400 };
    nextIntegration = meta.value;
    warnings.push(...meta.warnings);
    if (patch.specUrl !== undefined || patch.selection !== undefined) {
      warnings.push('binding changed — re-run the sync to reconcile the mirrored tools');
    }
  }

  const [updated] = await db
    .update(toolGroups)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(bindingTouched ? { integration: nextIntegration } : {}),
      updatedAt: new Date(),
    })
    .where(eq(toolGroups.id, row.id))
    .returning();
  const backrefs = await listToolGroupBackrefs(ownerId);
  return { connector: toDTO(updated!, backrefs.get(groupSlug) ?? []), warnings };
}
