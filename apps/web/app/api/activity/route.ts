import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { listTraces } from '@/lib/traces';

/**
 * Recent agent/system activity for the live column in the app shell.
 * Polled client-side; owner-scoped via requireOwner.
 */
export async function GET() {
  const user = await requireOwner();
  const rows = await listTraces(user.id, { sinceHours: 24, limit: 40 });
  return NextResponse.json({ traces: rows });
}
