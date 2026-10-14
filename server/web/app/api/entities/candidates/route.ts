import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { findDuplicateCandidates } from '@mantle/content';

/** Near-duplicate entity candidates for the review surface (dismissed pairs
 *  already filtered out). */
export async function GET() {
  const user = ownerCaller();
  const candidates = await findDuplicateCandidates(user.id);
  return NextResponse.json({ candidates });
}
