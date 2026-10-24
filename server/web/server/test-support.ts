/**
 * Test support for the server tier: nothing in the server imports it (A10
 * lows, part 2 #7: it lived in app-error.ts, the production answer).
 * runRoute (run-route.ts) drives the full pipeline; this is for a test that
 * calls a handler directly.
 */
import type { Context } from 'hono';
import { routePolicy, type RoutePolicyDeclaration } from '../lib/auth/route-declaration';
import { answerAppError } from './app-error';
import { routeManifest } from './route-manifest.gen';

/** A route handler's answer as the app gives it: its Response, or
 *  answerAppError's answer to what it threw. For a test that calls a
 *  handler directly, with no app around it (a domain error answers by its
 *  row, as behind app.onError). */
export async function appAnswerOf(
  res: Response | Promise<Response>,
  url = 'http://localhost/api/',
  method = 'POST',
): Promise<Response> {
  try {
    return await res;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return answerAppError(err, { req: { url, method } } as unknown as Context);
  }
}

/**
 * A hand-built test manifest with each route's real declaration (S9 part
 * 2): the policy the app's route file declares for the pattern (the
 * generated manifest, route-manifest.gen.ts), for the methods the entry
 * serves. registerRoutes refuses a manifest whose route declares no policy
 * (requireRouteDeclarations), for every caller, so a test's stand-in
 * handlers on a real pattern carry that pattern's real rows. An entry that
 * declares its own keeps it; a pattern or method the app does not serve
 * throws (declare it by hand: standInPolicy), or with `loose` stays
 * undeclared (a test of the boot's refusal).
 */
export function withRealPolicies<
  E extends Readonly<{ pattern: string; methods: readonly string[]; policy?: unknown }>,
>(
  entries: readonly E[],
  opts: Readonly<{ loose?: boolean }> = {},
): Array<E & { policy?: RoutePolicyDeclaration }> {
  type Out = E & { policy?: RoutePolicyDeclaration };
  return entries.map((e): Out => {
    if (e.policy !== undefined) return e as Out;
    const real = routeManifest.find((r) => r.pattern === e.pattern)?.policy as
      Readonly<Record<string, unknown>> | undefined;
    // `loose`: a pattern the app does not serve stays undeclared, for a
    // test of the boot's refusal of it.
    if (opts.loose === true && (!real || e.methods.some((m) => !Object.hasOwn(real, m)))) {
      return e as Out;
    }
    const policy: Record<string, unknown> = {};
    const reads = (e as Readonly<{ reads?: Readonly<Record<string, unknown>> }>).reads ?? {};
    for (const m of e.methods) {
      if (!real || !Object.hasOwn(real, m)) {
        throw new Error(`withRealPolicies: the app declares no ${m} ${e.pattern}: declare it`);
      }
      // A named caller the stand-in handler does not read (it calls the
      // guard itself, or reads nothing) is left out: the row is then the
      // one the lists built for it (caller null), as the test had it.
      const { caller, ...rest } = real[m] as Readonly<{ caller?: unknown }>;
      policy[m] = caller !== undefined && reads[m] !== caller ? rest : real[m];
    }
    return { ...e, policy: policy as RoutePolicyDeclaration };
  });
}

/**
 * The declaration of a test's own route, on a pattern the app does not
 * serve (the loader's tests): public (it judges its own credential, so no
 * caller is asked), a write naming no item. Never an app route's: those
 * declare in their file (route-plumbing.mjs route-policy-declared).
 */
export function standInPolicy(methods: readonly string[]): RoutePolicyDeclaration {
  const policy: Record<string, unknown> = {};
  for (const m of methods) {
    policy[m] =
      m === 'GET' || m === 'HEAD'
        ? { class: 'public' }
        : { class: 'public', item: { none: 'a test route of its own' } };
  }
  return routePolicy(policy as RoutePolicyDeclaration);
}

/** A loader test's manifest, each entry declared (its own policy, or
 *  standInPolicy for the methods it serves). */
export function standInDeclared<
  E extends Readonly<{ methods: readonly string[]; policy?: RoutePolicyDeclaration }>,
>(entries: readonly E[]): E[] {
  return entries.map((e) =>
    e.policy !== undefined ? e : { ...e, policy: standInPolicy(e.methods) },
  );
}

/**
 * For a test of the rows alone (buildRoutePolicy over a hand-built
 * manifest): the entries with their real declarations (withRealPolicies,
 * `loose`), and the app's own entry of each base a declaration names
 * (`aliasOf`, `base`) that the entries do not serve, its real declaration
 * and reads with it: a v1 row is built against its served base, as in the
 * app's manifest.
 */
export function withRealBases<
  E extends Readonly<{ pattern: string; methods: readonly string[]; policy?: unknown }>,
>(entries: readonly E[]): E[] {
  const out = withRealPolicies(entries, { loose: true });
  const served = new Set(out.flatMap((e) => e.methods.map((m) => `${m} ${e.pattern}`)));
  const more: E[] = [];
  for (const e of out) {
    const policy = (e.policy ?? {}) as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    for (const p of Object.values(policy)) {
      const key = (p.aliasOf ?? p.base) as string | undefined;
      if (key === undefined || served.has(key)) continue;
      const [m, pattern] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
      const real = routeManifest.find((r) => r.pattern === pattern);
      const declared = (real?.policy as Readonly<Record<string, unknown>> | undefined)?.[m];
      if (!real || declared === undefined) continue;
      const reads = (real.reads as Readonly<Record<string, string>> | undefined)?.[m];
      more.push({
        pattern,
        methods: [m],
        ...(reads ? { reads: { [m]: reads } } : {}),
        policy: { [m]: declared },
      } as unknown as E);
      served.add(key);
    }
  }
  return [...out, ...more];
}
