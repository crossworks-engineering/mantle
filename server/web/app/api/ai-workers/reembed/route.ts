import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { reembedIndex } from '@/lib/ai-worker-rpc';

/** Rebuild every stored vector against the currently-configured embedding model. */
export async function POST() {
  const user = ownerCaller();
  return NextResponse.json(await reembedIndex(user.id));
}
