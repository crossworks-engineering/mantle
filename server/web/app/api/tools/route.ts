import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  applyIntegrationInheritance,
  describeInheritance,
  getGroupIntegration,
} from '@mantle/tools';
import { db, toolGroups, and, eq } from '@mantle/db';
import { createTool, listToolsForOwner } from '@/lib/tools';
import { ToolHandlerSchema } from '@/lib/tool-handler-schema';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const rows = await listToolsForOwner(user.id);
  return NextResponse.json({ tools: rows });
}

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash/underscore'),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  handler: ToolHandlerSchema,
  /** Integration group to author into — the console's "Save as agent tool" flow
   *  offers it, and the tool inherits the group's base URL + credential
   *  placement exactly as `api_tool_create` does. */
  groupSlug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
  requiresConfirm: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { groupSlug, ...toolInput } = parsed.data;
  let inherited: string | null = null;
  if (groupSlug) {
    const group = await getGroupIntegration(user.id, groupSlug);
    if (!group) {
      return NextResponse.json({ error: `Tool group "${groupSlug}" not found.` }, { status: 400 });
    }
    if (toolInput.handler.kind === 'http') {
      // Same authoring-time fold as api_tool_create: the STORED handler carries
      // the group's base URL + credential, so the dispatcher stays untouched.
      const resolved = applyIntegrationInheritance(group.integration, {
        url: toolInput.handler.url,
        ...(toolInput.handler.headers ? { headers: toolInput.handler.headers } : {}),
        ...(toolInput.handler.query ? { query: toolInput.handler.query } : {}),
      });
      if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
      toolInput.handler = {
        ...toolInput.handler,
        url: resolved.url,
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        ...(resolved.query ? { query: resolved.query } : {}),
      };
      inherited = describeInheritance(resolved.inherited);
    }
  }
  try {
    const row = await createTool(user.id, toolInput);
    if (groupSlug) {
      const [group] = await db
        .select({ id: toolGroups.id, toolSlugs: toolGroups.toolSlugs })
        .from(toolGroups)
        .where(and(eq(toolGroups.ownerId, user.id), eq(toolGroups.slug, groupSlug)))
        .limit(1);
      if (group && !(group.toolSlugs ?? []).includes(row.slug)) {
        await db
          .update(toolGroups)
          .set({ toolSlugs: [...(group.toolSlugs ?? []), row.slug], updatedAt: new Date() })
          .where(eq(toolGroups.id, group.id));
      }
    }
    return NextResponse.json({
      tool: row,
      ...(groupSlug ? { groupSlug } : {}),
      ...(inherited ? { inherited } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('tools_owner_slug_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: `A tool with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
