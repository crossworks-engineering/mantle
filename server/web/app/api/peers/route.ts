import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { createPeer, listPeers } from '@mantle/content';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ peers: await listPeers(user.id) });
}

const CreateBody = z.object({
  displayName: z.string().min(1).max(200),
  baseUrl: z.string().min(1).max(500),
  // Optional: without it the peer is created 'pending' (inbound token minted
  // + revealed so the pairing can start; outbound disabled until provided).
  outboundToken: z.string().max(8192).optional(),
  description: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    // `inboundToken` is the plaintext to hand the peer — surfaced ONCE here.
    const { peer, inboundToken } = await createPeer(user.id, parsed.data);
    return NextResponse.json({ peer, inboundToken }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
