import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { recentAgentContext, spendInRange, type SpendRange } from '@/lib/metrics';

const VALID_RANGES: SpendRange[] = ['day', 'week', 'month'];

function readRange(value: string | null): SpendRange {
  return (VALID_RANGES as string[]).includes(value ?? '') ? (value as SpendRange) : 'day';
}

/**
 * GET /api/metrics/usage?range=day|week|month — the sidebar usage card's data:
 * spend over the range, plus per-agent context fill for every agent that ran a
 * responder turn in the last 24h.
 *
 * The card used to be a server component reading the DB in-process. The carve
 * (fc1708ea) left the owner UI zero-secret, so it lost its data source and was
 * deleted with "resurrect via an API route" as the stated follow-up. This is
 * that route; the numbers are unchanged, only their delivery.
 *
 * Read on the anchor `user.id`, not the actor: spend and context fill describe
 * the BRAIN, so every login sees the same card rather than a slice keyed to
 * whoever signed in.
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;

  const range = readRange(new URL(req.url).searchParams.get('range'));
  const [spend, contexts] = await Promise.all([
    spendInRange(user.id, range),
    recentAgentContext(user.id),
  ]);
  return NextResponse.json({ spend, contexts });
}
