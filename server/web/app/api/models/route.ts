import { NextResponse } from '@/server/http-compat';
import { isProviderId } from '@mantle/voice';
import { getOwnerOr401 } from '@/lib/auth';
import { fetchProviderModels } from '@/lib/model-explorer';

/**
 * GET /api/models?provider=<id>[&refresh=1]
 *
 * Live model catalog for one provider. `refresh=1` busts the 5-min server
 * cache (the page's Refresh button). Owner-scoped — the provider's stored API
 * key is resolved server-side and never leaves this route.
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') ?? '';
  if (!isProviderId(provider)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }
  const force = url.searchParams.get('refresh') === '1';
  const result = await fetchProviderModels(user.id, provider, { force });
  return NextResponse.json(result);
}
