import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { spendByAgent, spendByModel } from '@/lib/metrics';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/debug/spend — token spend by model + by agent over the last 7 days. */
export async function GET() {
  const user = ownerCaller();
  const [modelSpend, agentSpend] = await Promise.all([
    spendByModel(user.id, 7),
    spendByAgent(user.id, 7),
  ]);
  return NextResponse.json({ modelSpend, agentSpend });
}
