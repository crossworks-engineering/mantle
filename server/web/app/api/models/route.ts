import { NextResponse } from '@/server/http-compat';
import { isProviderId } from '@mantle/voice';
import { ownedKeyService } from '@mantle/api-keys';
import { isUuid } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { fetchProviderModels } from '@/lib/model-explorer';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/**
 * GET /api/models?provider=<id>[&keyId=<uuid>][&refresh=1]
 *
 * Live model catalog for one provider. `refresh=1` busts the 5-min server
 * cache (the page's Refresh button). `keyId` lists with that saved key (the
 * agent form's picked key): it must be one of the owner's keys AND this
 * provider's, else 404 / 400. Without it, the provider's own key on file
 * (the 'default' label, else the oldest key of that service). Owner
 * scoped: the key's plaintext is resolved server-side and never leaves this
 * route.
 */
export async function GET(req: Request) {
  const user = ownerCaller();
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') ?? '';
  if (!isProviderId(provider)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }
  const keyId = url.searchParams.get('keyId')?.trim() || null;
  if (keyId) {
    if (!isUuid(keyId)) {
      return NextResponse.json({ error: 'keyId must be a key id.' }, { status: 400 });
    }
    // Another owner's key and a missing one answer the same 404.
    const service = await ownedKeyService(user.id, keyId);
    if (!service) {
      return NextResponse.json({ error: 'API key not found.' }, { status: 404 });
    }
    if (service !== provider) {
      return NextResponse.json(
        { error: `That key is for ${service}, not ${provider}.` },
        { status: 400 },
      );
    }
  }
  const force = url.searchParams.get('refresh') === '1';
  const result = await fetchProviderModels(user.id, provider, { force, keyId });
  return NextResponse.json(result);
}
