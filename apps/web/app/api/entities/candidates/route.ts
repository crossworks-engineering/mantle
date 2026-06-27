import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { findDuplicateCandidates } from '@mantle/content';

/** Near-duplicate entity candidates for the review surface (dismissed pairs
 *  already filtered out). */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const candidates = await findDuplicateCandidates(user.id);
  return NextResponse.json({ candidates });
}
