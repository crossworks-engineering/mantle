import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { findDuplicateCandidates } from '@mantle/content';

/** Near-duplicate entity candidates for the review surface (dismissed pairs
 *  already filtered out). */
export async function GET() {
  const user = await requireOwner();
  const candidates = await findDuplicateCandidates(user.id);
  return NextResponse.json({ candidates });
}
