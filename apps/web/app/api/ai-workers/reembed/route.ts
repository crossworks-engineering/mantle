import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { reembedIndex } from '@/lib/ai-worker-rpc';

/** Rebuild every stored vector against the currently-configured embedding model. */
export async function POST() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await reembedIndex(user.id));
}
