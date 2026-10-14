import { NextResponse } from '@/server/http-compat';
import { runBackup } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';

/** Run a backup right now (manual trigger) and return the resulting status. */
export async function POST() {
  const user = ownerCaller();
  const status = await runBackup(user.id, 'manual');
  return NextResponse.json({ status });
}
