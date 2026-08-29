import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteMcpConnector } from '@mantle/tools';
import { getMcpConnector, updateMcpConnector } from '@/lib/mcp-connectors';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { slug } = await params;
  const connector = await getMcpConnector(user.id, slug);
  if (!connector) {
    return NextResponse.json({ error: `MCP connector '${slug}' not found` }, { status: 404 });
  }
  return NextResponse.json({ connector });
}

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  url: z.string().min(1).max(2000).optional(),
  /** '' clears the credential. */
  secretRef: z.string().max(160).optional(),
  authHeader: z.string().max(64).optional(),
  authScheme: z.string().max(20).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { slug } = await params;
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const result = await updateMcpConnector(user.id, slug, parsed.data);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { slug } = await params;
  const deleted = await deleteMcpConnector(user.id, slug);
  if (!deleted) {
    return NextResponse.json({ error: `MCP connector '${slug}' not found` }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
