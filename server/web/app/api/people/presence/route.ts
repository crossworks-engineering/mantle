import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { PEOPLE_PRESENCE_MAX, peopleCallerOf, peoplePresence } from '@/lib/people';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { PeoplePresenceResponse } from '@mantle/client-types/dto/people';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['peopleRead'] } },
});

/**
 * GET /api/people/presence?ids=a,b,c: the cheap poll, `{ id, state,
 * lastActiveAt }` for the ids the caller may see (the people gate); an id
 * it may not see is left out, as an unknown one is. At most 200 ids are
 * read (PEOPLE_PRESENCE_MAX): the rest of a longer list is ignored.
 */
export async function GET(req: Request) {
  const login = anyLoginCaller();
  const raw = new URL(req.url).searchParams.get('ids') ?? '';
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, PEOPLE_PRESENCE_MAX);
  const presence = await peoplePresence(peopleCallerOf(login), ids);
  return NextResponse.json({ presence } satisfies PeoplePresenceResponse);
}
