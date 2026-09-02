import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, curatedModels } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { MODEL_POOL_IDS } from '@/lib/model-pools';
import { firstIssue } from '@/lib/zod-issue';

const IdParams = z.object({ id: z.string().uuid() });

const Route = z.object({
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
  model: z.string().min(1).max(200),
});

const Pricing = z.object({
  inputPerM: z.number().nonnegative().nullable(),
  outputPerM: z.number().nonnegative().nullable(),
  currency: z.literal('USD').default('USD'),
  capturedAt: z.string(),
  source: z.string().min(1).max(64),
});

const PatchBody = z.object({
  pool: z
    .string()
    .refine((p) => MODEL_POOL_IDS.has(p), 'unknown pool')
    .optional(),
  name: z.string().trim().min(1).max(120).optional(),
  vendor: z.string().trim().max(80).nullable().optional(),
  routes: z.array(Route).min(1).optional(),
  pricing: Pricing.nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const b = parsed.data;
  const [row] = await db
    .update(curatedModels)
    .set({
      ...(b.pool !== undefined ? { pool: b.pool } : {}),
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.vendor !== undefined ? { vendor: b.vendor } : {}),
      ...(b.routes !== undefined ? { routes: b.routes } : {}),
      ...(b.pricing !== undefined ? { pricing: b.pricing } : {}),
      ...(b.rating !== undefined ? { rating: b.rating } : {}),
      ...(b.note !== undefined ? { note: b.note } : {}),
      ...(b.position !== undefined ? { position: b.position } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(curatedModels.id, idParsed.data.id), eq(curatedModels.ownerId, user.id)))
    .returning();
  if (!row) return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
  return NextResponse.json({ entry: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const deleted = await db
    .delete(curatedModels)
    .where(and(eq(curatedModels.id, idParsed.data.id), eq(curatedModels.ownerId, user.id)))
    .returning({ id: curatedModels.id });
  if (deleted.length === 0)
    return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
