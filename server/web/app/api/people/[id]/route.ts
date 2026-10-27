import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { peopleCallerOf, personCards } from '@/lib/people';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { PersonResponse } from '@mantle/client-types/dto/people';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['peopleRead'] } },
});

/** GET /api/people/:id: one person's card, when the caller may see that
 *  person (the people gate); else the one 404, as for no such login. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const [person] = await personCards(peopleCallerOf(login), { only: [id] });
  if (!person) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ person } satisfies PersonResponse);
}
