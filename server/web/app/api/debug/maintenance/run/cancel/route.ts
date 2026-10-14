import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { cancelRun } from '@/lib/maintenance/run-store';

// Cancel the in-flight maintenance run (SIGTERM the child).

export async function POST() {
  ownerCaller();
  const res = cancelRun();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
