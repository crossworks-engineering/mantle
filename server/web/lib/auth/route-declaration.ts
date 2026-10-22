/**
 * A route's policy, declared in its own file (plan v3.2, the route declarations): what each
 * method of the route is, beside its handler, so the declaration moves with
 * the file and no list elsewhere has to name the route.
 *
 *     export const policy = routePolicy({
 *       GET: { class: 'content', effect: 'read', open: 'owner' },
 *       POST: { class: 'content', effect: 'write', open: 'owner', creates: true },
 *     });
 *
 * The route manifest generator reads the declaration from the code
 * (scripts/route-callers.ts handlerPolicy) into the manifest (`policy`), so
 * the loader has it when it registers the route, without loading the
 * module; a declaration is data, literals only. buildRouteRow reads it in
 * place of the lists once ROUTE_POLICY_SOURCE says so (part 2). Until
 * then the rows come from the lists, and route-policy-declarations.test.ts
 * proves the declarations the codemod (scripts/route-policy-codemod.ts)
 * derives from them build every row equal.
 *
 * Only names and types here: no dependency on the app, so the generator
 * reads it without loading anything (as route-switches.ts).
 */
import type { WorkspaceArea } from '@mantle/client-types';
import type { AccessKeyArea } from '../access-keys';
import type { RateLimitName } from '../route-limits';

/** The name of the export a route file declares its policy by. */
export const ROUTE_POLICY_EXPORT = 'policy';

/** The methods a declaration names (a HEAD the GET handler answers takes
 *  its GET's; a route that exports its own HEAD declares it). */
export const DECLARED_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

export type DeclaredMethod = (typeof DECLARED_METHODS)[number];

/** Which login list opens the route to a login outside Admin (RouteRow
 *  `logins`): the owner routes a member may call, the any-login routes,
 *  the chat routes, the Telegram pairing routes, the member routes. None:
 *  a user of Admin only. */
export type DeclaredOpen = 'owner' | 'any' | 'chat' | 'telegram' | 'member';

/** The item a write names (RouteRow `item`): the path param that holds
 *  its id and what the write needs of it; or none, with the reason (plan
 *  v3.2 S11b: every write row says one). */
export type DeclaredItem =
  Readonly<{ param: string; need: 'read' | 'edit' | 'manage' }> | Readonly<{ none: string }>;

/** What the gate checks of the request before its handler (RouteRow
 *  `crossSite` and `rateLimit`; route-limits.ts RATE_LIMITS names each
 *  limit). */
export type DeclaredLimits = Readonly<{
  crossSite?: 'json' | 'origin';
  rateLimit?: readonly RateLimitName[];
}>;

type Common = Readonly<{
  /** Whether the method only reads (a POST may, a GET may write). */
  effect: 'read' | 'write';
  open?: DeclaredOpen;
  /** It creates an item: ?ws= names where it lands. */
  creates?: true;
  /** A write that makes no item (the login's own marks, running an app):
   *  its private workspace is never made for it. A DELETE never makes one. */
  makesItems?: false;
  item?: DeclaredItem;
  /** An /api/v1 row of the key table: the area a key needs (null: a key
   *  with every area), or 'self', about the key itself (whoami). */
  keyArea?: AccessKeyArea | null | 'self';
  limits?: DeclaredLimits;
  /** An /api/v1 alias: the base route whose handler the file re-exports
   *  (`METHOD pattern`). */
  aliasOf?: string;
}>;

/** One method's policy. `class` is the row's class; an `area` row names the
 *  Admin area it manages. `public`: the gate lets it in with no credential
 *  (a 'public' or 'link' row always is; a 'self' or 'area' row may be, as
 *  sign-in or the branding). `scope: null` on a 'self' row: no owner guard
 *  serves it (an any-login route outside every owner prefix). */
export type MethodPolicy =
  | (Common & Readonly<{ class: 'area'; area: WorkspaceArea; public?: true }>)
  | (Common & Readonly<{ class: 'content' }>)
  | (Common & Readonly<{ class: 'self'; public?: true; scope?: null }>)
  | (Common & Readonly<{ class: 'public' | 'link' }>);

/** A route file's declaration: each method it exports to its policy. */
export type RoutePolicyDeclaration = Readonly<Partial<Record<DeclaredMethod, MethodPolicy>>>;

/** A route file's policy, as declared (the identity: the type checks the
 *  shape, buildRouteRow the values). */
export function routePolicy<const T extends RoutePolicyDeclaration>(declaration: T): T {
  return declaration;
}

/** Whether `name` is a method a declaration may name. */
export function isDeclaredMethod(name: string): name is DeclaredMethod {
  return (DECLARED_METHODS as readonly string[]).includes(name);
}
