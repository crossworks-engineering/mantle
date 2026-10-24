import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { createPdfPassword, listPdfPasswords } from '@mantle/content';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'keys' },
  POST: {
    class: 'area',
    area: 'keys',
    item: { none: 'manages the keys area: the Admin step checks it' },
  },
});

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
  // No password (InputError) answers 400 by the one table (A10 part 2); a
  // fault the opaque 500.
  const row = await createPdfPassword(user.id, body);
  return NextResponse.json({ password: row }, { status: 201 });
}
