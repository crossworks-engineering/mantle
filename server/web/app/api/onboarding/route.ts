import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
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

/**
 * Onboarding wizard backend — the first-run flow's reads (GET) + every step's
 * mutation (POST, dispatched by `action`). Consolidated to one route because
 * it's a single internal flow (replaces app/onboarding/actions.ts). The steps
 * themselves live in lib/onboarding-steps.ts, shared with the terminal wizard
 * (scripts/onboard.ts); this file only maps a request onto them.
 */

export type { SanityCheck } from '@/lib/onboarding-steps';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await onboardingState(user.id));
}

/** Step dispatcher. Body is `{ action, ...payload }`. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  switch (body.action) {
    case 'step':
      return NextResponse.json(await saveStep(user.id, String(body.step ?? '')));
    case 'profile':
      return NextResponse.json(
        await saveProfile(user.id, {
          timezone: String(body.timezone ?? ''),
          locale: String(body.locale ?? ''),
          displayName: String(body.displayName ?? ''),
        }),
      );
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
      return NextResponse.json(await provision(user.id));
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
