import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
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
  try {
    const row = await createTool(user.id, parsed.data);
    return NextResponse.json({ tool: row });
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
