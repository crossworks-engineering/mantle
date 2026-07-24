import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { createPdfPassword, listPdfPasswords } from '@mantle/content';

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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const row = await createPdfPassword(user.id, parsed.data);
    return NextResponse.json({ password: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
