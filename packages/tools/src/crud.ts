/**
 * Owner-scoped CRUD for the `tools` registry. Built-ins are seeded by the
 * agent on boot — they should NOT be mutated here (slug + handler shape
 * live in code). User-defined tools (http/shell) flow through these
 * helpers.
 *
 * Lives in the package (not apps/web) because three surfaces share it:
 * the web /api/tools routes, the Toolsmith agent's api_tool_* builtins,
 * and the MCP server's api_tool_* tools for Claude Code/Desktop.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db, tools, type Tool, type ToolHandler } from '@mantle/db';
import type { ToolDTO } from '@mantle/client-types';

/** The API/wire shape (see @mantle/client-types). Aliased here so `toSummary`'s
 *  output is checked against the client contract — drift is a type error. */
export type ToolSummary = ToolDTO;

function toSummary(t: Tool): ToolSummary {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    handler: t.handler as ToolHandler,
    requiresConfirm: t.requiresConfirm,
    enabled: t.enabled,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function listToolsForOwner(ownerId: string): Promise<ToolSummary[]> {
  const rows = await db
    .select()
    .from(tools)
    .where(eq(tools.ownerId, ownerId))
    .orderBy(asc(tools.slug));
  return rows.map(toSummary);
}

export async function getToolById(ownerId: string, id: string): Promise<ToolSummary | null> {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, ownerId)))
    .limit(1);
  return row ? toSummary(row) : null;
}

export type CreateToolInput = {
  slug: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: ToolHandler;
  requiresConfirm?: boolean;
  enabled?: boolean;
};

export async function createTool(ownerId: string, input: CreateToolInput): Promise<ToolSummary> {
  if (input.handler.kind === 'builtin') {
    throw new Error('cannot register builtin tools via API — they are seeded by the agent');
  }
  if (input.handler.kind === 'mcp') {
    throw new Error(
      "cannot register 'mcp' tools by hand — they are materialised by an MCP connector's sync (create the connector via POST /api/mcp-connectors)",
    );
  }
  if (input.handler.kind === 'http' && input.handler.openapi) {
    throw new Error(
      "cannot register a tool carrying openapi connector provenance by hand — such rows are materialised by an OpenAPI connector's sync (create the connector via POST /api/openapi-connectors)",
    );
  }
  const [row] = await db
    .insert(tools)
    .values({
      ownerId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      inputSchema: input.inputSchema ?? { type: 'object', properties: {} },
      handler: input.handler,
      requiresConfirm: input.requiresConfirm ?? input.handler.kind === 'shell',
      enabled: input.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error('failed to insert tool');
  return toSummary(row);
}

export type UpdateToolInput = Partial<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  requiresConfirm: boolean;
  enabled: boolean;
}>;

export async function updateTool(
  ownerId: string,
  id: string,
  patch: UpdateToolInput,
): Promise<ToolSummary | null> {
  const existing = await getToolById(ownerId, id);
  if (!existing) return null;
  if (existing.handler.kind === 'builtin' && patch.handler && patch.handler.kind !== 'builtin') {
    throw new Error('cannot change a builtin tool to another kind');
  }
  // Connector-mirrored rows: enabled/requiresConfirm may toggle, everything
  // else is the sync's to write — and no other row may be turned INTO one.
  if (existing.handler.kind === 'mcp' && patch.handler !== undefined) {
    throw new Error(
      "connector tools mirror the remote server — edit the connector's binding and re-run its sync instead of patching the handler (enabled/requires_confirm can still toggle)",
    );
  }
  if (existing.handler.kind !== 'mcp' && patch.handler?.kind === 'mcp') {
    throw new Error(
      "cannot change a tool into an 'mcp' handler — connector tools are materialised by their connector's sync",
    );
  }
  // OpenAPI-mirrored rows are ordinary http tools whose definition MAY be
  // edited (the plan's deliberate difference from mcp), but their provenance
  // is the sync's bookkeeping: it must survive every edit, an edit stamps
  // `editedAt` so the next sync leaves the row alone, and no other row can be
  // dressed up as a mirror.
  const existingOpenapi = existing.handler.kind === 'http' ? existing.handler.openapi : undefined;
  if (existingOpenapi) {
    if (patch.handler !== undefined && patch.handler.kind !== 'http') {
      throw new Error(
        "cannot change an openapi connector tool to another handler kind — edit its http definition, or manage the row via its connector's sync",
      );
    }
    const editsDefinition =
      patch.handler !== undefined ||
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.inputSchema !== undefined;
    if (editsDefinition) {
      // Both sides are http here (the non-http patch case threw above).
      const base = (patch.handler ?? existing.handler) as Extract<ToolHandler, { kind: 'http' }>;
      patch.handler = {
        ...base,
        openapi: { ...existingOpenapi, editedAt: new Date().toISOString() },
      };
    }
  } else if (patch.handler?.kind === 'http' && patch.handler.openapi) {
    throw new Error(
      "cannot attach openapi connector provenance to a tool — such rows are materialised by an OpenAPI connector's sync",
    );
  }
  if (
    existing.handler.kind === 'builtin' &&
    (patch.name !== undefined ||
      patch.description !== undefined ||
      patch.inputSchema !== undefined ||
      patch.handler !== undefined)
  ) {
    // Allow toggling enabled / requiresConfirm on builtins; everything else
    // is overwritten by seedBuiltinTools on next boot anyway.
    if (
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.inputSchema !== undefined ||
      patch.handler !== undefined
    ) {
      throw new Error(
        'cannot edit name/description/schema/handler of a builtin tool — edit packages/tools/src/builtins.ts and restart',
      );
    }
  }
  const next: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.inputSchema !== undefined) next.inputSchema = patch.inputSchema;
  if (patch.handler !== undefined) next.handler = patch.handler;
  if (patch.requiresConfirm !== undefined) next.requiresConfirm = patch.requiresConfirm;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  const [row] = await db
    .update(tools)
    .set(next)
    .where(and(eq(tools.id, id), eq(tools.ownerId, ownerId)))
    .returning();
  return row ? toSummary(row) : null;
}

export async function deleteTool(ownerId: string, id: string): Promise<boolean> {
  const existing = await getToolById(ownerId, id);
  if (!existing) return false;
  if (existing.handler.kind === 'builtin') {
    throw new Error(
      'cannot delete a builtin tool — remove from packages/tools/src/builtins.ts and restart',
    );
  }
  if (existing.handler.kind === 'mcp') {
    throw new Error(
      `cannot delete a connector-mirrored tool — it would leave its connector group dangling; delete the whole connector (DELETE /api/mcp-connectors/${existing.handler.group.replace(/^mcp-/, '')}) or let its sync manage the row`,
    );
  }
  if (existing.handler.kind === 'http' && existing.handler.openapi) {
    throw new Error(
      `cannot delete an openapi connector tool — disable it, drop the operation from the connector's selection, or delete the whole connector (DELETE /api/openapi-connectors/${existing.handler.openapi.group.replace(/^openapi-/, '')})`,
    );
  }
  const rows = await db
    .delete(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, ownerId)))
    .returning({ id: tools.id });
  return rows.length > 0;
}
