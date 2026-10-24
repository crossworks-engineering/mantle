import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { cancelRun } from '@/lib/maintenance/run-store';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

// Cancel the in-flight maintenance run (SIGTERM the child).

export async function POST() {
  ownerCaller();
  const res = cancelRun();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
