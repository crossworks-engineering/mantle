import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import {
  finishOnboarding,
  onboardingState,
  provision,
  runInfraChecks,
  runSanityChecks,
  saveEmbedding,
  saveKey,
  saveModels,
  savePersona,
  saveProfile,
  savePurpose,
  saveStep,
  testKey,
} from '@/lib/onboarding-steps';
import { loadProfilePreferences } from '@mantle/content';
import { toolMakerFor, vaultPairRefusalFor } from '@/lib/tools';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/**
 * Onboarding wizard backend — the first-run flow's reads (GET) + every step's
 * mutation (POST, dispatched by `action`). Consolidated to one route because
 * it's a single internal flow (replaces app/onboarding/actions.ts). The steps
 * themselves live in lib/onboarding-steps.ts, shared with the terminal wizard
 * (scripts/onboard.ts); this file only maps a request onto them.
 */

export type { SanityCheck } from '@/lib/onboarding-steps';

export async function GET() {
  const user = ownerCaller();
  return NextResponse.json(await onboardingState(user.id));
}

/** Whether the saved Models step pins the routes to an Azure endpoint. */
async function provisionsAzureRoute(ownerId: string): Promise<boolean> {
  const models = (await loadProfilePreferences(ownerId)).onboardingModels;
  return models?.route === 'azure' && !!models.azureBaseUrl;
}

/** Why a login other than the brain owner may not save the purpose or the
 *  persona step. */
const PROMPT_TEXT_ANCHOR_ONLY =
  "The brain's own prompt text (the purpose and the assistant's persona) is set by the brain owner only.";

/** Step dispatcher. Body is `{ action, ...payload }`. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const body = (await readJson(req)) as Record<string, unknown>;

  // Writing a vault key, or pointing the model routes at an Azure endpoint
  // with the vault's 'custom' key, is the keys area's, not the settings
  // area's (@mantle/tools secret-ref-gate.ts). The anchor
  // login always may.
  // Provisioning writes the saved Azure endpoint and the 'custom' key onto
  // the model routes: that pairing is the provisioner's too, whoever saved
  // the Models step.
  const touchesVault =
    body.action === 'saveKey' ||
    (body.action === 'embedding' && String(body.plaintext ?? '').trim() !== '') ||
    (body.action === 'models' && body.route === 'azure') ||
    (body.action === 'provision' && (await provisionsAzureRoute(user.id)));
  if (touchesVault) {
    const refused = await vaultPairRefusalFor(user);
    if (refused) {
      return NextResponse.json({ ok: false, message: refused, error: refused }, { status: 403 });
    }
  }
  // The purpose (and its archetype) and the persona assistant's prompt and
  // name are the brain's own prompt text: they ride every agent's prompt, so
  // every heartbeat's turn. Only the brain owner (the anchor login) sets
  // them, as under /api/profile.
  if ((body.action === 'purpose' || body.action === 'persona') && toolMakerFor(user)) {
    return NextResponse.json(
      { ok: false, message: PROMPT_TEXT_ANCHOR_ONLY, error: PROMPT_TEXT_ANCHOR_ONLY },
      { status: 403 },
    );
  }

  switch (body.action) {
    case 'step':
      return NextResponse.json(await saveStep(user.id, String(body.step ?? '')));
    case 'profile':
      // The time zone, locale and name are the signed-in login's own
      // (personal preference keys): saved to its own row, never the brain
      // owner's. Only the wizard's step, a brain key, lands on the
      // anchor's row (savePreferencesFor). For the anchor both are one row.
      return NextResponse.json(await saveProfile(user.actor.id, body));
    case 'saveKey':
      return NextResponse.json(
        await saveKey(user.id, String(body.service ?? ''), String(body.plaintext ?? '')),
      );
    case 'models':
      return NextResponse.json(await saveModels(user.id, body));
    case 'embedding':
      return NextResponse.json(await saveEmbedding(user.id, body));
    case 'testKey':
      return NextResponse.json(await testKey(user.id, String(body.service ?? '')));
    case 'provision':
      return NextResponse.json(await provision(user.id, toolMakerFor(user)));
    case 'infra':
      return NextResponse.json(
        await runInfraChecks(req.headers.get('x-forwarded-host') ?? req.headers.get('host')),
      );
    case 'sanity':
      return NextResponse.json(await runSanityChecks(user.id));
    case 'purpose': {
      const { status, ...result } = await savePurpose(
        user.id,
        String(body.archetype ?? ''),
        String(body.purpose ?? ''),
      );
      return NextResponse.json(result, status ? { status } : undefined);
    }
    case 'persona':
      // zod strips the extra `action` field.
      return NextResponse.json(await savePersona(user.id, body));
    case 'finish':
      return NextResponse.json(await finishOnboarding(user.id));
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
