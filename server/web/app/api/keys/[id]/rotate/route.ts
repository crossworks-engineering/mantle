import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { rotateApiKey } from '@/lib/api-keys';

const RotateBody = z.object({
  plaintext: z.string().min(1).max(8192),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const idParse = z.string().uuid().safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const raw = await req.json().catch(() => ({}));
  const body = RotateBody.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: 'Plaintext required.' }, { status: 400 });
  }
  const row = await rotateApiKey(user.id, idParse.data, body.data.plaintext);
  if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ id: row.id, updatedAt: row.updatedAt });
}
