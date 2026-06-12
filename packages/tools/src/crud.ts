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

export type ToolSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  requiresConfirm: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

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

export async function getToolById(
  ownerId: string,
  id: string,
): Promise<ToolSummary | null> {
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

export async function createTool(
  ownerId: string,
  input: CreateToolInput,
): Promise<ToolSummary> {
  if (input.handler.kind === 'builtin') {
    throw new Error('cannot register builtin tools via API — they are seeded by the agent');
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
  if (
    existing.handler.kind === 'builtin' &&
    (patch.name !== undefined ||
      patch.description !== undefined ||
      patch.inputSchema !== undefined ||
      patch.handler !== undefined)
  ) {
    // Allow toggling enabled / requiresConfirm on builtins; everything else
    // is overwritten by seedBuiltinTools on next boot anyway.
    if (patch.name !== undefined || patch.description !== undefined || patch.inputSchema !== undefined || patch.handler !== undefined) {
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
    throw new Error('cannot delete a builtin tool — remove from packages/tools/src/builtins.ts and restart');
  }
  const rows = await db
    .delete(tools)
    .where(and(eq(tools.id, id), eq(tools.ownerId, ownerId)))
    .returning({ id: tools.id });
  return rows.length > 0;
}
