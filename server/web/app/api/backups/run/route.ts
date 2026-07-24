import { NextResponse } from 'next/server';
import { runBackup } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

/** Run a backup right now (manual trigger) and return the resulting status. */
export async function POST() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const status = await runBackup(user.id, 'manual');
  return NextResponse.json({ status });
}
