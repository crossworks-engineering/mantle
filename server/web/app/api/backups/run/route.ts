import { NextResponse } from '@/server/http-compat';
import { runBackup } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** Run a backup right now (manual trigger) and return the resulting status. */
export async function POST() {
  const user = ownerCaller();
  const status = await runBackup(user.id, 'manual');
  return NextResponse.json({ status });
}
