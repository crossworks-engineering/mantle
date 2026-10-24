import { NextResponse } from '@/server/http-compat';
import { loadContactGate } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
});

/**
 * Inbox inbound allowlist state. The contacts list IS the email allowlist, so
 * an empty gate means nothing is being ingested — the inbox uses this to show
 * the "add a contact" nudge. `isEmpty` is true when the owner has zero contact
 * email/domain entries (own-account addresses don't count); see
 * `loadContactGate` in @mantle/content for the exact rule.
 */
export async function GET() {
  const user = ownerCaller();
  const gate = await loadContactGate(user.id);
  return NextResponse.json({ isEmpty: gate.isEmpty });
}
