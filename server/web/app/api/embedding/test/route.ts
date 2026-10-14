import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { probeEmbeddingRoute } from '@mantle/embeddings';
import { ownerCaller } from '@/lib/auth';
import { getEmbeddingConfig } from '@/lib/embedding-config';
import { modelRoutePairing } from '@/lib/model-route-pair';
import { toolMakerFor, vaultPairRefusalFor } from '@/lib/tools';
import { errorMessage } from '@mantle/std';

const Body = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().nullable(),
  apiKeyId: z.string().nullable(),
});

/** Probe one route's live output dimension (bypasses resolver + cache). */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid input' });
  if (!parsed.data.model.trim()) return NextResponse.json({ ok: false, error: 'No model set' });
  // The probe sends a vault key (the key id, or the provider's key it falls
  // back to) to the base URL: a pair not already saved on a route is the
  // keys area's; a saved one answers to the login that paired it (W7a fix
  // rounds 4 and 5, lib/model-route-pair.ts).
  const probe = modelRoutePairing(parsed.data.apiKeyId, parsed.data.baseUrl, parsed.data.provider);
  let configuredBy: string | null = null;
  if (probe.key) {
    const stored = await getEmbeddingConfig(user.id);
    const saved = [
      modelRoutePairing(stored?.primaryApiKeyId, stored?.primaryBaseUrl, stored?.primaryProvider),
      modelRoutePairing(stored?.backupApiKeyId, stored?.backupBaseUrl, stored?.backupProvider),
    ].some((p) => p.key === probe.key && p.dest === probe.dest);
    const refused = saved ? null : await vaultPairRefusalFor(user);
    if (refused) return NextResponse.json({ ok: false, error: refused }, { status: 403 });
    configuredBy = saved ? (stored?.configuredBy ?? null) : toolMakerFor(user);
  }
  try {
    const dimensions = await probeEmbeddingRoute(user.id, { ...parsed.data, configuredBy });
    return NextResponse.json({ ok: true, dimensions });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: errorMessage(err),
    });
  }
}
