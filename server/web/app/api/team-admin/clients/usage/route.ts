/**
 * GET /api/team-admin/clients/usage (client logins C4): each client login's
 * chat use today (UTC), against the caps every client login has (decision 7
 * A: the member caps). The budget card in Team admin > Clients. Admin only.
 */
import { NextResponse } from '@/server/http-compat';
import { clientChatUsageSince, listClientLogins } from '@mantle/content';
import type { ClientChatUsage } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { MEMBER_DAILY_CAP, MEMBER_DAILY_TOKENS, startOfTodayUtc } from '@/lib/member-daily-cap';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [clients, usage] = await Promise.all([
    listClientLogins(user.id),
    clientChatUsageSince(user.id, startOfTodayUtc()),
  ]);
  const body: ClientChatUsage = {
    limits: { dailyTurns: MEMBER_DAILY_CAP, dailyTokens: MEMBER_DAILY_TOKENS },
    rows: clients.map((c) => ({
      loginId: c.id,
      turnsToday: usage.get(c.id)?.turns ?? 0,
      tokensToday: usage.get(c.id)?.tokens ?? 0,
    })),
  };
  return NextResponse.json(body);
}
