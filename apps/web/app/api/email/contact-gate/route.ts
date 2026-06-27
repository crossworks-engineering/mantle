import { NextResponse } from 'next/server';
import { loadContactGate } from '@mantle/content';
import { requireOwner } from '@/lib/auth';

/**
 * Inbox inbound allowlist state. The contacts list IS the email allowlist, so
 * an empty gate means nothing is being ingested — the inbox uses this to show
 * the "add a contact" nudge. `isEmpty` is true when the owner has zero contact
 * email/domain entries (own-account addresses don't count); see
 * `loadContactGate` in @mantle/content for the exact rule.
 */
export async function GET() {
  const user = await requireOwner();
  const gate = await loadContactGate(user.id);
  return NextResponse.json({ isEmpty: gate.isEmpty });
}
