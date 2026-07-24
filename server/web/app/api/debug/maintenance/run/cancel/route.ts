import { NextResponse } from '@/server/http-compat';

import { getOwnerOr401 } from '@/lib/auth';
import { cancelRun } from '@/lib/maintenance/run-store';

// Cancel the in-flight maintenance run (SIGTERM the child).

export async function POST() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const res = cancelRun();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
