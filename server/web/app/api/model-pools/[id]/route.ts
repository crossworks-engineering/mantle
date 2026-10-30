import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, curatedModels, onNarrowSpots, onFullSystemRoute } from '@mantle/db';
import { ownerCaller } from '@/lib/auth';
import { MODEL_POOL_IDS } from '@/lib/model-pools';
import { poolRoutesIssue } from '@/lib/model-pool-routes';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
  DELETE: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

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
  // A new route or a move to another pool is checked as an add is: against
  // the entry's pool and routes after the patch.
  if (b.pool !== undefined || b.routes !== undefined) {
    const [stored] = await db
      .select({ name: curatedModels.name, pool: curatedModels.pool, routes: curatedModels.routes })
      .from(curatedModels)
      .where(and(eq(curatedModels.id, idParsed.data.id), eq(curatedModels.ownerId, user.id)));
    if (!stored) return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
    const storedRoutes = Array.isArray(stored.routes)
      ? (stored.routes as { provider: string; model: string }[])
      : [];
    const issue = await poolRoutesIssue(b.pool ?? stored.pool, b.routes ?? storedRoutes);
    if (issue) {
      return NextResponse.json(
        { error: `'${b.name ?? stored.name}' does not fit this pool: ${issue}` },
        { status: 400 },
      );
    }
  }
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
  const [row] = await onNarrowSpots(curatedModels, 'update', set, write);
  if (!row) return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
  return NextResponse.json({ entry: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  // An entry removed: model-route, as its add and edit.
  const deleted = await onFullSystemRoute('model-route', () =>
    db
      .delete(curatedModels)
      .where(and(eq(curatedModels.id, idParsed.data.id), eq(curatedModels.ownerId, user.id)))
      .returning({ id: curatedModels.id }),
  );
  if (deleted.length === 0)
    return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
