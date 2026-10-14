import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { createPdfPassword, listPdfPasswords } from '@mantle/content';
import { readBody } from '@/lib/read-body';

export async function GET() {
  const user = ownerCaller();
  return NextResponse.json({ passwords: await listPdfPasswords(user.id) });
}

const CreateBody = z.object({
  label: z.string().max(120).optional(),
  password: z.string().min(1).max(256),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, CreateBody);
  try {
    const row = await createPdfPassword(user.id, body);
    return NextResponse.json({ password: row }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
