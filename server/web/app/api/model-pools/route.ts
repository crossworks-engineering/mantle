import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db, curatedModels } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';
import { MODEL_POOLS, MODEL_POOL_IDS, poolModelIssue } from '@/lib/model-pools';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const entries = await db
    .select()
    .from(curatedModels)
    .where(eq(curatedModels.ownerId, user.id))
    .orderBy(asc(curatedModels.pool), asc(curatedModels.position), asc(curatedModels.createdAt));
  return NextResponse.json({ pools: MODEL_POOLS, entries });
}

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

const CreateBody = z.object({
  pool: z.string().refine((p) => MODEL_POOL_IDS.has(p), 'unknown pool'),
  name: z.string().trim().min(1).max(120),
  vendor: z.string().trim().max(80).optional(),
  routes: z.array(Route).min(1),
  pricing: Pricing.optional(),
  rating: z.number().int().min(1).max(5).optional(),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid input.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const b = parsed.data;
  // Does the model actually do the pool's job? "Read images" and "Image
  // generation" both accept images, so an image GENERATOR reads like a
  // perfect vision model on inputs alone — the catalog's output modalities
  // are what separate them. Fail-open: an unloaded catalog or a non-
  // OpenRouter route allows the save (see catalogModalities).
  const orRoute = b.routes.find((r) => r.provider === 'openrouter');
  if (orRoute) {
    const { refreshModelCatalog, catalogModalities } = await import('@mantle/tracing');
    await refreshModelCatalog();
    const issue = poolModelIssue(b.pool, catalogModalities(orRoute.model));
    if (issue) {
      return NextResponse.json(
        { error: `'${b.name}' does not fit this pool: ${issue}` },
        { status: 400 },
      );
    }
  }
  // Append at the end of the pool.
  const inPool = await db
    .select({ position: curatedModels.position })
    .from(curatedModels)
    .where(and(eq(curatedModels.ownerId, user.id), eq(curatedModels.pool, b.pool)));
  const nextPos = inPool.reduce((m, r) => Math.max(m, r.position + 1), 0);
  try {
    const [row] = await db
      .insert(curatedModels)
      .values({
        ownerId: user.id,
        pool: b.pool,
        position: nextPos,
        name: b.name,
        vendor: b.vendor ?? null,
        routes: b.routes,
        pricing: b.pricing ?? null,
        rating: b.rating ?? null,
        note: b.note ?? null,
      })
      .returning();
    return NextResponse.json({ entry: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('curated_models_owner_pool_name_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: `'${b.name}' is already in the ${b.pool} pool.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
