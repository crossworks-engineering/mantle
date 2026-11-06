import { z } from 'zod';
import { oidcModeWord } from '@mantle/config';
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { routePolicy } from '@/lib/auth/route-declaration';
import { ssoSetupPasswordRefusal } from '@/lib/oidc/flow';
import { notifySsoSetupChange } from '@/lib/oidc/notify';
import { envScimTokenSet } from '@/lib/oidc/sso-setup';
import { saveSsoScimHash } from '@/lib/oidc/store';
import { readBody } from '@/lib/read-body';
import { newScimToken } from '@/lib/scim/settings';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'users',
    item: { none: 'manages the users area: the Admin step checks it' },
    limits: { rateLimit: ['ssoSetup'] },
    audit: 'own',
  },
});

const Body = z.object({ password: z.string().min(1).max(1024) });

/**
 * POST /api/users/sso-setup/scim-token: make the SCIM token, only with the
 * mode word `setup` (docs/oidc-sign-in.md). It replaces the one before, and
 * SCIM uses it at once. The hash is stored; this answer alone holds the token.
 * Any value in MANTLE_SCIM_TOKEN_HASH wins, `off` too.
 */
export async function POST(req: Request) {
  const user = ownerCaller();
  if (oidcModeWord() !== 'setup') {
    return NextResponse.json(
      { error: 'The setup screen is locked.', code: 'setup-closed' },
      { status: 403 },
    );
  }
  if (envScimTokenSet()) {
    return NextResponse.json(
      { error: 'The box .env holds the SCIM token setting.', code: 'env-wins' },
      { status: 409 },
    );
  }
  const body = await readBody(req, Body);
  const refused = await ssoSetupPasswordRefusal(req, user.actor, body.password);
  if (refused) return refused;
  const { token, hash } = newScimToken();
  await saveSsoScimHash(hash, user.actor.id);
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'auth.sso_setup_scim_token_made',
    method: 'POST',
    path: '/api/users/sso-setup/scim-token',
    detail: { field: 'scim-token' },
    ...requestMetaFrom(req),
  });
  // Not awaited: a failed or slow push cannot lose the token stored above.
  void notifySsoSetupChange('scim-token');
  return NextResponse.json({ token });
}
