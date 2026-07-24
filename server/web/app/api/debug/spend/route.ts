import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { spendByAgent, spendByModel } from '@/lib/metrics';

/** GET /api/debug/spend — token spend by model + by agent over the last 7 days. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [modelSpend, agentSpend] = await Promise.all([
    spendByModel(user.id, 7),
    spendByAgent(user.id, 7),
  ]);
  return NextResponse.json({ modelSpend, agentSpend });
}
