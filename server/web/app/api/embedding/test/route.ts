import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { probeEmbeddingRoute } from '@mantle/embeddings';
import { getOwnerOr401 } from '@/lib/auth';

const Body = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().nullable(),
  apiKeyId: z.string().nullable(),
});

/** Probe one route's live output dimension (bypasses resolver + cache). */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid input' });
  if (!parsed.data.model.trim()) return NextResponse.json({ ok: false, error: 'No model set' });
  try {
    const dimensions = await probeEmbeddingRoute(user.id, parsed.data);
    return NextResponse.json({ ok: true, dimensions });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
