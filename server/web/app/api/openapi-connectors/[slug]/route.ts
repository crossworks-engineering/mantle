import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { deleteOpenapiConnector } from '@mantle/tools';
import { getOpenapiConnector, updateOpenapiConnector } from '@/lib/openapi-connectors';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { slug } = await params;
  const connector = await getOpenapiConnector(user.id, slug);
  if (!connector) {
    return NextResponse.json({ error: `OpenAPI connector '${slug}' not found` }, { status: 404 });
  }
  return NextResponse.json({ connector });
}

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  specUrl: z.string().min(1).max(2000).optional(),
  /** '' clears the base URL (the next sync re-adopts from the spec). */
  baseUrl: z.string().max(2000).optional(),
  /** '' clears the credential. */
  secretRef: z.string().max(160).optional(),
  authTemplate: z
    .object({
      headers: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
      query: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
    })
    .nullable()
    .optional(),
  selection: z
    .object({
      tags: z.array(z.string().min(1).max(200)).max(40).optional(),
      operations: z.array(z.string().min(1).max(200)).max(200).optional(),
    })
    .nullable()
    .optional(),
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
  const result = await updateOpenapiConnector(user.id, slug, parsed.data);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { slug } = await params;
  const deleted = await deleteOpenapiConnector(user.id, slug);
  if (!deleted) {
    return NextResponse.json({ error: `OpenAPI connector '${slug}' not found` }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
