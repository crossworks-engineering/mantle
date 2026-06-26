import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { reembedIndex } from '@/lib/ai-worker-rpc';

/** Rebuild every stored vector against the currently-configured embedding model. */
export async function POST() {
  const user = await requireOwner();
  return NextResponse.json(await reembedIndex(user.id));
}
