import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { createPdfPassword, listPdfPasswords } from '@mantle/content';
import { firstIssue } from '@/lib/zod-issue';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ passwords: await listPdfPasswords(user.id) });
}

const CreateBody = z.object({
  label: z.string().max(120).optional(),
  password: z.string().min(1).max(256),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const row = await createPdfPassword(user.id, parsed.data);
    return NextResponse.json({ password: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
