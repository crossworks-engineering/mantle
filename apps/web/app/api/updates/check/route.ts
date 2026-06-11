/**
 * Release check for the sidebar's "Update available" banner. Server-side
 * cached (6h TTL in lib/updates.ts), so the banner polling every sidebar
 * mount never hammers the GitHub API.
 */
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { checkForUpdate } from '@/lib/updates';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json(await checkForUpdate(false));
}
