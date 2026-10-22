import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, curatedModels, narrowNeedsSpot, onFullSystemRoute } from '@mantle/db';
import { ownerCaller } from '@/lib/auth';
import { MODEL_POOL_IDS } from '@/lib/model-pools';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';

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
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const parsed = PatchBody.safeParse(await readJson(req));
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const b = parsed.data;
  const set = {
    ...(b.pool !== undefined ? { pool: b.pool } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.vendor !== undefined ? { vendor: b.vendor } : {}),
    ...(b.routes !== undefined ? { routes: b.routes } : {}),
    ...(b.pricing !== undefined ? { pricing: b.pricing } : {}),
    ...(b.rating !== undefined ? { rating: b.rating } : {}),
    ...(b.note !== undefined ? { note: b.note } : {}),
    ...(b.position !== undefined ? { position: b.position } : {}),
    updatedAt: new Date(),
  };
  const write = () =>
    db
      .update(curatedModels)
      .set(set)
      .where(and(eq(curatedModels.id, idParsed.data.id), eq(curatedModels.ownerId, user.id)))
      .returning();
  // An entry's model, routes, price or place (what the picker offers and a
  // combo applies) is not the narrow login's to change (it keeps the stamp,
  // the insert and the delete: access-matrix.ts NARROW_WRITES): the
  // full-route spot model-route.
  const [row] = narrowNeedsSpot(curatedModels, 'update', set)
    ? await onFullSystemRoute('model-route', write)
    : await write();
  if (!row) return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
  return NextResponse.json({ entry: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
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
