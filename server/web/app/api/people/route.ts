import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { peopleCallerOf, personCards } from '@/lib/people';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { PeopleListResponse } from '@mantle/client-types/dto/people';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['peopleRead'] } },
});

/** GET /api/people: the card of every person the caller may see (the
 *  people gate: itself, the people of its live workspaces, every usable
 *  login for an Admin user, the people of its chats), by name. One query. */
export async function GET() {
  const login = anyLoginCaller();
  const people = await personCards(peopleCallerOf(login));
  return NextResponse.json({ people } satisfies PeopleListResponse);
}
