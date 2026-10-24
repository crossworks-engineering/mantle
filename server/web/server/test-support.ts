/**
 * Test support for the server tier: nothing in the server imports it (A10
 * lows, part 2 #7: it lived in app-error.ts, the production answer).
 * runRoute (run-route.ts) drives the full pipeline; this is for a test that
 * calls a handler directly.
 */
import type { Context } from 'hono';
import {
  methodEffect,
  routePolicy,
  type MethodPolicy,
  type RoutePolicyDeclaration,
} from '../lib/auth/route-declaration';
import {
  anyLoginRow,
  buildRoutePolicy,
  type RouteManifestEntry,
  type RouteRow,
} from '../lib/auth/route-policy';
import type { RouteClass } from '../lib/auth/route-scope';
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

/**
 * What the deleted route lists answered, read off the rows the route files'
 * declarations build (S9 part 3): the sweeps choose their routes with these,
 * so each chooses the routes it chose from the lists. A HEAD is in no login
 * list (they named GET only) and a read is its row's effect, as before.
 * `prefixClass` is the class a pattern's prefix gave (route-scope.ts
 * ROUTE_PREFIXES): its rows' scope, but the rows a named carve-out made the
 * login's own (the Telegram chats, the update banner), which keep the
 * prefix's area; scripts proved each answer equal to the lists' over every
 * route and method of the manifest before the lists went.
 */
export type RowAnswers = Readonly<{
  rowOf: (method: string, pattern: string) => RouteRow | null;
  isReadRequest: (method: string, pattern: string) => boolean;
  isMemberRoute: (method: string, pattern: string) => boolean;
  isAnyLoginRoute: (method: string, pattern: string) => boolean;
  memberMayRead: (method: string, pattern: string) => boolean;
  memberMayWrite: (method: string, pattern: string) => boolean;
  prefixClass: (pattern: string) => RouteClass | null;
}>;

export function rowAnswers(manifest: readonly RouteManifestEntry[] = routeManifest): RowAnswers {
  const rows = buildRoutePolicy(manifest);
  const byPattern = new Map<string, RouteRow[]>();
  for (const row of rows.values()) {
    const list = byPattern.get(row.pattern) ?? [];
    list.push(row);
    byPattern.set(row.pattern, list);
  }
  const rowOf = (method: string, pattern: string) =>
    rows.get(`${method.toUpperCase()} ${pattern}`) ?? null;
  // A login list named GET, never HEAD; the open reads read HEAD as GET.
  const listed = (method: string, pattern: string) =>
    method.toUpperCase() === 'HEAD' ? null : rowOf(method, pattern);
  // A v1 row opens to a login as its base does (D3): the base's list, not
  // its own (the member lists named no v1 route).
  const ownList = (row: RouteRow | null) =>
    row !== null && !row.pattern.startsWith('/api/v1/') ? row.logins : null;
  return {
    rowOf,
    isReadRequest: (method, pattern) => {
      const row = rowOf(method, pattern);
      return row ? row.effect === 'read' : methodEffect(method) === 'read';
    },
    isMemberRoute: (method, pattern) => ownList(listed(method, pattern)) === 'member',
    isAnyLoginRoute: (method, pattern) => {
      const row = listed(method, pattern);
      return row !== null && anyLoginRow(row);
    },
    memberMayRead: (method, pattern) => {
      const m = method.toUpperCase() === 'HEAD' ? 'GET' : method;
      const row = rowOf(m, pattern);
      return ownList(row) === 'owner' && row!.effect === 'read';
    },
    memberMayWrite: (method, pattern) => {
      const row = listed(method, pattern);
      return ownList(row) === 'owner' && row!.effect === 'write';
    },
    prefixClass: (pattern) => {
      const of = byPattern.get(pattern) ?? [];
      const carved = (r: RouteRow) => r.logins === 'telegram' || r.caller === 'session';
      const plain = of.find((r) => !carved(r));
      if (plain) return plain.scope;
      // Every row of the pattern is a carve-out: the prefix named an area
      // (the Telegram routes: connectors).
      return of.length > 0 && of.every((r) => r.logins === 'telegram')
        ? { kind: 'area', area: 'connectors' }
        : null;
    },
  };
}

/**
 * The app's declaration of `method pattern` (its route file's, from the
 * generated manifest; a HEAD the GET handler answers: its GET's), for a
 * test that builds one row by hand (buildRouteRow reads a row from a
 * declaration only, S9 part 3), and `served`, the manifest's keys, for an
 * alias's base. Throws where the app declares none.
 */
export function realDeclaration(
  method: string,
  pattern: string,
): Readonly<{
  served: (key: string) => boolean;
  declared: MethodPolicy;
  declaredOf: (key: string) => MethodPolicy | undefined;
}> {
  const policyOf = (m: string, p: string): MethodPolicy | undefined => {
    const e = routeManifest.find((r) => r.pattern === p);
    if (!e?.policy) return undefined;
    const as = m === 'HEAD' && !e.methods.includes('HEAD') ? 'GET' : m;
    return (e.policy as Readonly<Record<string, MethodPolicy | undefined>>)[as];
  };
  const declared = policyOf(method.toUpperCase(), pattern);
  if (!declared) throw new Error(`realDeclaration: the app declares no ${method} ${pattern}`);
  const keys = new Set(
    routeManifest.flatMap((e) =>
      [...e.methods, ...(e.methods.includes('GET') ? ['HEAD'] : [])].map(
        (m) => `${m} ${e.pattern}`,
      ),
    ),
  );
  return {
    served: (key) => keys.has(key),
    declared,
    declaredOf: (key) => {
      const at = key.indexOf(' ');
      return policyOf(key.slice(0, at), key.slice(at + 1));
    },
  };
}
