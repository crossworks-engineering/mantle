/**
 * GET  /api/secrets             — list metadata (no ciphertext, no fields)
 * POST /api/secrets             — create a new secret + sealed payload
 *
 * The reveal endpoint is intentionally separate (`/api/secrets/[id]/reveal`)
 * so it shows up distinctly in access logs and pen-test inventories.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  SECRET_KINDS,
  countSecrets,
  createSecret,
  listSecrets,
} from '@/lib/secrets';

const PAGE_SIZE = 50;

const FieldSchema = z.object({
  label: z.string().max(80),
  value: z.string().max(8000),
});

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional().default(''),
  kind: z.enum(SECRET_KINDS),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
  note: z.string().max(50_000).optional().default(''),
  fields: z.array(FieldSchema).max(32).optional().default([]),
});

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const query = url.searchParams.get('q') ?? undefined;
  const kindParam = url.searchParams.get('kind');
  const kind =
    kindParam && kindParam !== 'all' && (SECRET_KINDS as readonly string[]).includes(kindParam)
      ? (kindParam as (typeof SECRET_KINDS)[number])
      : 'all';
  const tag = url.searchParams.get('tag') ?? undefined;
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [secrets, total] = await Promise.all([
    listSecrets(user.id, { query, kind, tag, limit: PAGE_SIZE, offset }),
    countSecrets(user.id, { query, kind, tag }),
  ]);
  return NextResponse.json({ secrets, total, page, pageSize: PAGE_SIZE });
}

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
  const row = await createSecret(user.id, parsed.data);
  return NextResponse.json({ secret: row }, { status: 201 });
}
