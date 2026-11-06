import { z } from 'zod';
import { oidcModeWord } from '@mantle/config';
import { seal } from '@mantle/crypto';
import { SSO_SECRET_AAD } from '@mantle/db';
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { routePolicy } from '@/lib/auth/route-declaration';
import { ssoSetupPasswordRefusal } from '@/lib/oidc/flow';
import { notifySsoSetupChange } from '@/lib/oidc/notify';
import { envSecretSet, ssoSetupStatus } from '@/lib/oidc/sso-setup';
import { saveSsoSecret } from '@/lib/oidc/store';
import { readBody } from '@/lib/read-body';

export const policy = routePolicy({
  GET: { class: 'area', area: 'users' },
  PUT: {
    class: 'area',
    area: 'users',
    item: { none: 'manages the users area: the Admin step checks it' },
    limits: { rateLimit: ['ssoSetup'] },
    audit: 'own',
  },
});

/**
 * GET /api/users/sso-setup: the setup screen's status (docs/oidc-sign-in.md).
 * Mode off: `{ mode: 'off' }`, with no read. Never a value of the secret or
 * the token's hash. No-store, as every /api answer that names no cache rule
 * (lib/cache-control.ts).
 */
export async function GET() {
  ownerCaller();
  if (oidcModeWord() === 'off') {
    return NextResponse.json({ mode: 'off' });
  }
  return NextResponse.json(await ssoSetupStatus());
}

const Body = z.object({
  secret: z.string().trim().min(1).max(1024),
  password: z.string().min(1).max(1024),
});

/**
 * PUT /api/users/sso-setup: seal and store the client secret. Only with the
 * mode word `setup`; a secret in the box .env wins. There is no way to clear
 * it: replace it. A refusal never echoes it.
 */
export async function PUT(req: Request) {
  const user = ownerCaller();
  if (oidcModeWord() !== 'setup') {
    return NextResponse.json(
      { error: 'The setup screen is locked.', code: 'setup-closed' },
      { status: 403 },
    );
  }
  if (envSecretSet()) {
    return NextResponse.json(
      { error: 'The box .env holds the client secret.', code: 'env-wins' },
      { status: 409 },
    );
  }
  const body = await readBody(req, Body);
  const refused = await ssoSetupPasswordRefusal(req, user.actor, body.password);
  if (refused) return refused;
  await saveSsoSecret(seal(body.secret, SSO_SECRET_AAD).ciphertext, user.actor.id);
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'auth.sso_setup_secret_set',
    method: 'PUT',
    path: '/api/users/sso-setup',
    detail: { field: 'secret' },
    ...requestMetaFrom(req),
  });
  // Not awaited: a slow push must not hold the answer.
  void notifySsoSetupChange('secret');
  return NextResponse.json(await ssoSetupStatus());
}
