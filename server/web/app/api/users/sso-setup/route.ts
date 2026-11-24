import { z } from 'zod';
import { oidcLabelInEnv, oidcModeWord } from '@mantle/config';
import { SSO_LABEL_MAX, SSO_LABEL_REFUSED, ssoLabelValue } from '@mantle/client-types/sso-label';
import { seal } from '@mantle/crypto';
import { loadOidcRow, SSO_SECRET_AAD } from '@mantle/db';
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

const Body = z
  .object({
    secret: z.string().trim().min(1).max(1024).optional(),
    // '' clears it; else the pattern (@mantle/client-types sso-label.ts).
    label: z
      .string()
      .max(SSO_LABEL_MAX * 4)
      .refine((v) => ssoLabelValue(v) !== false, { message: SSO_LABEL_REFUSED })
      .optional(),
    password: z.string().min(1).max(1024),
  })
  .refine((b) => b.secret !== undefined || b.label !== undefined, {
    message: 'Give a client secret or a label.',
  });

/**
 * PUT /api/users/sso-setup: the setup screen's save. The client secret is
 * sealed and stored, only with the mode word `setup`; there is no way to
 * clear it: replace it. The button's label (0399) in any mode but off; ''
 * clears it. A value the box .env holds wins (409 `env-wins`). A save that
 * cannot apply every value it carries applies none. A refusal never echoes
 * the secret. The label is public, so its audit row names it.
 */
export async function PUT(req: Request) {
  const user = ownerCaller();
  const mode = oidcModeWord();
  if (mode === 'off') return closed();
  const body = await readBody(req, Body);
  if (body.secret !== undefined && mode !== 'setup') return closed();
  if (
    (body.secret !== undefined && envSecretSet()) ||
    (body.label !== undefined && oidcLabelInEnv())
  ) {
    return NextResponse.json(
      {
        error:
          body.secret !== undefined && envSecretSet()
            ? 'The box .env holds the client secret.'
            : 'The box .env holds the label.',
        code: 'env-wins',
      },
      { status: 409 },
    );
  }
  const refused = await ssoSetupPasswordRefusal(req, user.actor, body.password);
  if (refused) return refused;
  const label = body.label === undefined ? undefined : ssoLabelValue(body.label) || null;
  await saveSsoSecret(
    {
      ...(body.secret !== undefined
        ? { secretEnc: seal(body.secret, SSO_SECRET_AAD).ciphertext }
        : {}),
      ...(label !== undefined ? { label } : {}),
    },
    user.actor.id,
  );
  const audit = (
    action: 'auth.sso_setup_secret_set' | 'auth.sso_setup_label_set',
    detail: object,
  ) =>
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
      action,
      method: 'PUT',
      path: '/api/users/sso-setup',
      detail: detail as Record<string, unknown>,
      ...requestMetaFrom(req),
    });
  if (body.secret !== undefined) {
    audit('auth.sso_setup_secret_set', { field: 'secret' });
    // Not awaited: a slow push must not hold the answer.
    void notifySsoSetupChange('secret');
  }
  if (label !== undefined) {
    audit('auth.sso_setup_label_set', { field: 'label', label });
    // This process shows the new label at once; the others within 60
    // seconds (@mantle/db watchOidcRow). A failed read keeps the save.
    await loadOidcRow().catch(() => {});
    void notifySsoSetupChange('label');
  }
  return NextResponse.json(await ssoSetupStatus());
}

/** 403 `setup-closed`: the mode word is off, or a secret came while it is
 *  not `setup`. */
function closed() {
  return NextResponse.json(
    { error: 'The setup screen is locked.', code: 'setup-closed' },
    { status: 403 },
  );
}
