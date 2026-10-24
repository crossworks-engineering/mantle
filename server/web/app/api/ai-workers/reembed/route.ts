import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { reembedIndex } from '@/lib/ai-worker-rpc';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** Rebuild every stored vector against the currently-configured embedding model. */
export async function POST() {
  const user = ownerCaller();
  return NextResponse.json(await reembedIndex(user.id));
}
