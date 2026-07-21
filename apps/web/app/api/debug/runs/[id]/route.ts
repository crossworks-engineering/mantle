import { NextResponse } from 'next/server';
import { db } from '@mantle/db';
import { compileRunState } from '@mantle/runs';
import { getOwnerOr401 } from '@/lib/auth';

/** GET /api/debug/runs/:id — one run's compiled tree (the run view payload). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await params;
  const compiled = await compileRunState(db, id);
  if (!compiled || compiled.run.ownerId !== user.id) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  return NextResponse.json(compiled);
}
