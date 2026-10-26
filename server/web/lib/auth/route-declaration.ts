/**
 * A route's policy, declared in its own file (plan v3.2, the route declarations): what each
 * method of the route is, beside its handler, so the declaration moves with
 * the file and no list elsewhere has to name the route.
 *
 *     export const policy = routePolicy({
 *       GET: { class: 'content', open: 'owner' },
 *       POST: { class: 'content', open: 'owner', creates: true, item: { none: '...' } },
 *     });
 *
 * The route manifest generator reads the declaration from the code
 * (scripts/route-callers.ts handlerPolicy) into the manifest (`policy`), so
 * the loader has it when it registers the route, without loading the
 * module; a declaration is data, literals only. buildRouteRow reads every
 * row from it (part 2); the lists the codemod wrote the declarations from
 * are gone (part 3), and route-policy-declarations.test.ts holds every row
 * to __snapshots__/route-policy.rows.json.
 *
 * One shape source: the const arrays below give the type, the checks of
 * validateMethodPolicy (the generator's, at pretypecheck, and the boot's,
 * route-policy.ts declaredFacts) and the lint's constants
 * (eslint-rules/route-plumbing.mjs imports this file). So it imports no
 * module of the app at run time, only the client types' name lists (Node
 * loads it as it is for the lint).
 */
import type { WorkspaceArea } from '@mantle/client-types';
import { isWorkspaceArea } from '@mantle/client-types/dto/workspaces';
import { ACCESS_KEY_AREAS } from '@mantle/client-types/dto/access-keys';
import type { AccessKeyArea } from '../access-keys';
import type { RateLimitName } from '../route-limits';

/** The name of the export a route file declares its policy by. */
export const ROUTE_POLICY_EXPORT = 'policy';

/** The module a route file imports routePolicy from, by its own name (the
 *  generator, scripts/route-callers.ts, and the lint, route-plumbing.mjs,
 *  both refuse another). */
export const ROUTE_DECLARATION_MODULE = '@/lib/auth/route-declaration';

/** The methods a declaration names (a HEAD the GET handler answers takes
 *  its GET's; a route that exports its own HEAD declares it). The HTTP
 *  methods a route file exports, for the generator and the lint too. */
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

/** The methods that read (a row's effect by its method): every other one
 *  writes. A declaration states only an exception (`effect`). */
export const READ_METHODS = ['GET', 'HEAD'] as const;
type ReadMethod = (typeof READ_METHODS)[number];
type WriteMethod = Exclude<DeclaredMethod, ReadMethod>;

/** The one method that may state it reads (an effect exception `read`):
 *  a POST that only computes, as a GET with a body would (the formula
 *  calculator). A PUT, PATCH, DELETE or OPTIONS always writes; a GET or HEAD may state it writes (`write`), no other. */
export const READS_BY_EXCEPTION = 'POST';
type OtherWriteMethod = Exclude<WriteMethod, typeof READS_BY_EXCEPTION>;

/** The effect of `method` when its declaration states no exception. */
export function methodEffect(method: string): 'read' | 'write' {
  return (READ_METHODS as readonly string[]).includes(method.toUpperCase()) ? 'read' : 'write';
}

/** The methods that never write the generic `api.write` audit row by
 *  their method alone (route-scope.ts auditsAsWrite): the reads and
 *  OPTIONS. Every other method does; a row whose effect is a write does
 *  whatever its method. */
export const UNAUDITED_METHODS = [...READ_METHODS, 'OPTIONS'] as const;

/** Whether `method` writes the generic audit row by its method alone
 *  (route-scope.ts auditsAsWrite; a declaration's `audit` the same). */
export function auditsByMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== '' && !(UNAUDITED_METHODS as readonly string[]).includes(m);
}

/** The classes a row is declared with. */
export const DECLARED_CLASSES = ['public', 'link', 'self', 'area', 'content'] as const;

/** Which login list opens the route to a login outside Admin (RouteRow
 *  `logins`): the owner routes a member may call, the any-login routes,
 *  the chat routes, the Telegram pairing routes, the member routes. None:
 *  a user of Admin only. */
export const DECLARED_OPEN = ['owner', 'any', 'chat', 'telegram', 'member'] as const;
export type DeclaredOpen = (typeof DECLARED_OPEN)[number];

/** What a write needs of the item its path names. A route whose writes
 *  ask different rights (a rename and a move on one PATCH, a data restore
 *  and a code restore on one POST) declares the lowest right its handler
 *  accepts; the A8 route cells test the higher one as its own cell
 *  (a8-route-cells.ts, a spec's `higher`). */
export const ITEM_NEEDS = ['read', 'edit', 'manage'] as const;
/** The keys of an item a write names, and of an item it does not. A write
 *  with no one need whose path still names an item (a grant change) says
 *  none and the param that holds the item's id: the A8 coverage counts it
 *  (cells by the guide action it is, or a8Exempt). */
export const ITEM_KEYS = ['param', 'need'] as const;
export const ITEM_NONE_KEYS = ['none', 'param'] as const;

/** The reason part 1 wrote where the facts gave none: a write whose path
 *  names an item no check read yet. Each is decided now (a param and
 *  need, or a reason); validateMethodPolicy refuses it, at the generator and at
 *  boot, and the itemNonePlaceholders count holds it at 0. */
export const ITEM_NONE_PLACEHOLDER = 'not decided yet: the write names an item no check reads';

/** The item a write names (RouteRow `item`): the path param that holds
 *  its id and what the write needs of it; or none, with the reason. Every
 *  write says one (plan v3.2 S11b); a read says none. */
export type DeclaredItem =
  | Readonly<{ param: string; need: (typeof ITEM_NEEDS)[number]; none?: never }>
  | Readonly<{ none: string; param?: string; need?: never }>;

/** The keys of `limits` (RouteRow `crossSite` and `rateLimit`). */
export const LIMIT_KEYS = ['crossSite', 'rateLimit'] as const;
export const CROSS_SITE = ['json', 'origin'] as const;

/** What the gate checks of the request before its handler (route-limits.ts
 *  RATE_LIMITS names each limit). */
export type DeclaredLimits = Readonly<{
  crossSite?: (typeof CROSS_SITE)[number];
  rateLimit?: readonly RateLimitName[];
}>;

/** The caller kinds read only on a row named for each (route-policy.ts
 *  callerServes): the login a public row reads ('publicLogin',
 *  'cookieUpgrade'), the owner taken at the read ('ownerAtRead'), the
 *  session user of an Admin row open to every Admin user ('session'), the
 *  frame ticket of a sandbox frame document ('frame'). A row names its
 *  kind here; the generator reads the kind its handler reads from the
 *  code, and the two must be one. */
export const NAMED_CALLERS = [
  'publicLogin',
  'cookieUpgrade',
  'ownerAtRead',
  'session',
  'frame',
] as const;
export type NamedCaller = (typeof NAMED_CALLERS)[number];

/** The keys of an effect exception: the effect, to why. */
export const EFFECT_KEYS = ['read', 'write'] as const;

/** Every key a method's policy may have. */
export const DECLARED_KEYS = [
  'class',
  'area',
  'public',
  'scope',
  'effect',
  'open',
  'caller',
  'creates',
  'makesItems',
  'item',
  'keyArea',
  'limits',
  'aliasOf',
  'base',
  'audit',
] as const;
type DeclaredKey = (typeof DECLARED_KEYS)[number];

type Common = Readonly<{
  open?: DeclaredOpen;
  /** The named caller kind its handler reads (NAMED_CALLERS). */
  caller?: NamedCaller;
  /** It creates an item: ?ws= names where it lands. A write only. */
  creates?: true;
  /** A write that makes no item (the login's own marks, running an app):
   *  its private workspace is never made for it. A DELETE never makes one. */
  makesItems?: false;
  /** An /api/v1 row of the key table: the area a key needs (null: a key
   *  with every area), or 'self', about the key itself (whoami). */
  keyArea?: AccessKeyArea | null | 'self';
  limits?: DeclaredLimits;
  /** An /api/v1 alias: the base route whose handler the file re-exports
   *  (`METHOD pattern`). Its open, creates and limits are the base's
   *  (open: 'owner' or none), so it declares none of them. */
  aliasOf?: string;
  /** An /api/v1 row with a handler of its own that admits a login as a
   *  base route does (`METHOD pattern`): its open and creates are the
   *  base's (open: 'owner' or none), so it declares neither. */
  base?: string;
  /** The write logs its own audit event: the generic `api.write` row is
   *  not written (session.ts auditMutation). A row that audits as a
   *  write only. */
  audit?: 'own';
}>;

/** `class` is the row's class; an `area` row names the Admin area it
 *  manages. `public`: the gate lets it in with no credential (a 'public'
 *  or 'link' row always is; a 'self' or 'area' row may be, as sign-in or
 *  the branding). `scope: null` on a 'self' row: no owner guard serves it
 *  (an any-login route outside every owner prefix). */
type ClassPart =
  | Readonly<{ class: 'area'; area: WorkspaceArea; public?: true }>
  | Readonly<{ class: 'content' }>
  | Readonly<{ class: 'self'; public?: true; scope?: null }>
  | Readonly<{ class: 'public' | 'link' }>;

/** A GET or HEAD reads, unless it states the write it is and why; then it
 *  says its item, as every write does. */
type ReadEffect =
  | Readonly<{ effect?: never; item?: never }>
  | Readonly<{ effect: Readonly<{ write: string }>; item: DeclaredItem }>;

/** A PUT, PATCH, DELETE or OPTIONS writes and says its item. */
type WriteEffect = Readonly<{ effect?: never; item: DeclaredItem }>;

/** A POST writes and says its item, unless it states the read it is and
 *  why. */
type PostEffect = WriteEffect | Readonly<{ effect: Readonly<{ read: string }>; item?: never }>;

/** The policy of a GET or a HEAD. */
export type ReadMethodPolicy = Common & ClassPart & ReadEffect;
/** The policy of a POST. */
export type PostMethodPolicy = Common & ClassPart & PostEffect;
/** The policy of a PUT, PATCH, DELETE or OPTIONS. */
export type WriteMethodPolicy = Common & ClassPart & WriteEffect;
/** One method's policy. */
export type MethodPolicy = ReadMethodPolicy | PostMethodPolicy | WriteMethodPolicy;

/** A route file's declaration: each method it exports to its policy. */
export type RoutePolicyDeclaration = Readonly<
  { [M in ReadMethod]?: ReadMethodPolicy } & {
    [M in typeof READS_BY_EXCEPTION]?: PostMethodPolicy;
  } & { [M in OtherWriteMethod]?: WriteMethodPolicy }
>;

// The keys the type allows are DECLARED_KEYS, no more and no fewer.
type KeysOf<T> = T extends unknown ? keyof T : never;
type Same<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : false;
const keysAreTheShape: Same<KeysOf<MethodPolicy>, DeclaredKey> = true;
void keysAreTheShape;

/** A route file's policy, as declared (the identity: the type checks the
 *  shape at every level, validateMethodPolicy the values). Not generic,
 *  so an excess key is an error wherever it is written. */
export function routePolicy(declaration: RoutePolicyDeclaration): RoutePolicyDeclaration {
  return declaration;
}

/** Whether `name` is a method a declaration may name. */
export function isDeclaredMethod(name: string): name is DeclaredMethod {
  return (DECLARED_METHODS as readonly string[]).includes(name);
}

const has = (list: readonly string[], v: unknown): boolean =>
  typeof v === 'string' && list.includes(v);

/** A plain object (not null, not an array) whose keys are each in `keys`
 *  and none `__proto__`; else the reason it is not. */
function exactObject(v: unknown, keys: readonly string[]): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'is no object';
  for (const k of Object.keys(v)) {
    if (k === '__proto__' || !keys.includes(k)) return `has the key ${k}, which it may not`;
  }
  return null;
}

/**
 * A copy of a declared value with no prototype at any level, frozen
 * (arrays copied and frozen too; any other value as it is). The validator
 * reads each value once, here, and checks and returns the copy: the rows
 * are built from it only, never from what a route module exported (a
 * getter, a prototype or a later change reads nothing). An own key
 * `__proto__` stays a key of the copy, so the shape check refuses it.
 */
function dataCopy(v: unknown): unknown {
  if (Array.isArray(v)) return Object.freeze(v.map(dataCopy));
  if (v === null || typeof v !== 'object') return v;
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    Object.defineProperty(out, k, {
      value: dataCopy((v as Record<string, unknown>)[k]),
      enumerable: true,
    });
  }
  return Object.freeze(out);
}

/** What an alias takes from its base's declaration (it runs the base's
 *  handler), and what a v1 row with a `base` takes (its own handler, its
 *  own limits). Neither declares them. */
export const ALIAS_COPIES = ['open', 'creates', 'limits'] as const;
export const BASE_COPIES = ['open', 'creates'] as const;

/** What an alias declares as its own, not its base's: the base it names
 *  and the key area its /api/v1 row needs. Every other key of
 *  DECLARED_KEYS is the base's: ALIAS_COPIES are read from the base, and
 *  each of the rest must say what the base's says (route-policy.ts
 *  declaredFacts), so a key added to the shape is held by default. */
export const ALIAS_OWN = ['aliasOf', 'keyArea'] as const;

/** The base route an alias or `base` names: `METHOD pattern`. */
export function splitRouteKey(key: string): { method: string; pattern: string } | null {
  const at = key.indexOf(' ');
  if (at < 1) return null;
  return { method: key.slice(0, at), pattern: key.slice(at + 1) };
}

/**
 * Check one method's declared policy: the one validator, run by the
 * generator on each route file it reads (scripts/route-callers.ts
 * handlerPolicy, at pretypecheck) and by the boot on each row it builds
 * from a declaration (route-policy.ts declaredFacts). Pure: it reads only
 * the value, the route's pattern and the method it is declared for. What
 * needs the whole manifest (an alias's base is served and declared, the
 * caller the code reads is the named one) and the rate limits' names
 * (route-limits.ts, also the type's) are the boot's. Throws on the first
 * thing that cannot hold; returns the checked copy (dataCopy), typed.
 */
export function validateMethodPolicy(raw: unknown, pattern: string, method: string): MethodPolicy {
  const bad = (what: string): never => {
    throw new Error(`ROUTE_POLICY: ${method} ${pattern} declares ${what}`);
  };
  if (!isDeclaredMethod(method)) bad(`a policy for ${method}, which is no method`);
  // The copy is what is checked and what is returned: a value read once,
  // with no prototype, frozen.
  const copy = dataCopy(raw);
  const shape = exactObject(copy, DECLARED_KEYS);
  if (shape) bad(`a policy that ${shape}`);
  const d = copy as Readonly<Record<string, unknown>>;
  const own = (k: DeclaredKey) => Object.hasOwn(d, k);
  if (!has(DECLARED_CLASSES, d.class)) bad(`the class ${String(d.class)}, which is none`);
  const cls = d.class as (typeof DECLARED_CLASSES)[number];
  if ((cls === 'link') !== pattern.startsWith('/s/')) {
    bad(`the class ${cls}: a link row is an /s route, and every /s route is one`);
  }
  if ((cls === 'area') !== own('area')) bad('an area on a row that is not of the class area');
  if (cls === 'area' && !isWorkspaceArea(d.area)) bad(`the area ${String(d.area)}, no area`);
  if (own('public') && (d.public !== true || (cls !== 'self' && cls !== 'area'))) {
    bad("public: only a 'self' or 'area' row says it (true); a 'public' or 'link' row is");
  }
  if (own('scope') && (d.scope !== null || cls !== 'self')) {
    bad("scope: only a 'self' row says it (null: no owner guard serves it)");
  }
  const isPublic = cls === 'public' || cls === 'link' || d.public === true;

  // The effect is the method's; a declaration states only an exception.
  let effect = methodEffect(method);
  if (own('effect')) {
    const e = exactObject(d.effect, EFFECT_KEYS);
    const keys = e ? [] : Object.keys(d.effect as object);
    if (e || keys.length !== 1) bad('an effect that is not { read: why } or { write: why }');
    const [k] = keys as Array<'read' | 'write'>;
    const why = (d.effect as Record<string, unknown>)[k!];
    if (typeof why !== 'string' || !why.trim()) bad(`the effect ${k} with no reason`);
    if (k === effect) bad(`the effect ${k}, which a ${method} is: state only an exception`);
    // A read only on a POST; a write only on a GET or HEAD (whose effect
    // is the read the check above refuses to restate).
    if (k === 'read' && method !== READS_BY_EXCEPTION) {
      bad(`the effect read on a ${method}: only a POST states it reads`);
    }
    effect = k!;
  }
  const writes = effect === 'write';

  if (own('open') && !has(DECLARED_OPEN, d.open)) bad(`open ${String(d.open)}`);
  // A member reaches an owner route through the item it names (its
  // workspace's content); a row that is no content has no item to grant
  // it, so open: 'owner' there would open an Admin or self route to every
  // member. Refused here, at the generator and at boot alike.
  if (d.open === 'owner' && cls !== 'content') {
    bad(`open owner on the class ${cls}: only a content row opens to a member's item`);
  }
  if (own('creates') && (d.creates !== true || !writes)) bad('creates: true, on a write only');
  if (own('makesItems') && (d.makesItems !== false || !writes)) {
    bad('makesItems: false, on a write only');
  }

  // Every write says its item; a read says none.
  if (own('item') !== writes) {
    bad(writes ? 'no item: a write says its item, or none and why' : 'an item on a read');
  }
  if (own('item')) {
    const it = d.item as Readonly<Record<string, unknown>> | null;
    if (it !== null && typeof it === 'object' && Object.hasOwn(it, 'none')) {
      const e = exactObject(it, ITEM_NONE_KEYS);
      if (e) bad(`an item that ${e}`);
      if (typeof it.none !== 'string' || !it.none.trim()) bad('item none with no reason');
      // Each was decided: the placeholder is no reason.
      if (it.none === ITEM_NONE_PLACEHOLDER) bad('item none with the placeholder: decide it');
      if (
        Object.hasOwn(it, 'param') &&
        (typeof it.param !== 'string' || !pattern.split('/').includes(`:${it.param}`))
      ) {
        bad(`its item in ${String(it.param)}, which is no param of its pattern`);
      }
    } else {
      const e = exactObject(it, ITEM_KEYS);
      if (e) bad(`an item that ${e}`);
      const param = it!.param;
      if (typeof param !== 'string' || !pattern.split('/').includes(`:${param}`)) {
        bad(`its item in ${String(param)}, which is no param of its pattern`);
      }
      if (!has(ITEM_NEEDS, it!.need)) bad(`the item need ${String(it!.need)}`);
    }
  }

  if (own('caller')) {
    if (!has(NAMED_CALLERS, d.caller)) bad(`the caller ${String(d.caller)}, no named kind`);
    const publicKind = d.caller === 'publicLogin' || d.caller === 'cookieUpgrade';
    if (publicKind !== isPublic) {
      bad(`the caller ${String(d.caller)}: a public row reads a public kind, and only it`);
    }
    if (d.caller === 'session' && (cls !== 'self' || own('open'))) {
      bad("the caller session: a 'self' row open to every Admin user, and no list");
    }
    if (d.caller === 'ownerAtRead' && cls === 'area') {
      bad('the caller ownerAtRead on an area row: the Admin step comes first');
    }
  }

  const v1 = pattern.startsWith('/api/v1/');
  if (own('keyArea')) {
    if (!v1) bad('a key area off /api/v1');
    const area = d.keyArea;
    if (area !== null && area !== 'self' && !has(ACCESS_KEY_AREAS, area)) {
      bad(`the key area ${String(area)}, which is none`);
    }
  }

  for (const k of ['aliasOf', 'base'] as const) {
    if (!own(k)) continue;
    const base = typeof d[k] === 'string' ? splitRouteKey(d[k] as string) : null;
    if (!v1 || !base || base.method !== method || base.pattern.startsWith('/api/v1/')) {
      bad(`${k} ${String(d[k])}: an /api/v1 row's base is the same method of a route off it`);
    }
    // One source: the base's own declaration says them.
    const copies = k === 'aliasOf' ? ALIAS_COPIES : BASE_COPIES;
    for (const copied of copies) {
      if (own(copied)) bad(`${copied} beside ${k}: the base route's declaration says it`);
    }
  }
  if (own('aliasOf') && own('base')) bad('both aliasOf and base: an alias runs its base');

  if (own('limits')) {
    const e = exactObject(d.limits, LIMIT_KEYS);
    if (e) bad(`limits that ${e}`);
    const l = d.limits as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(l, 'crossSite') && !has(CROSS_SITE, l.crossSite)) {
      bad(`the cross-site refusal ${String(l.crossSite)}`);
    }
    if (Object.hasOwn(l, 'rateLimit')) {
      const r = l.rateLimit;
      if (!Array.isArray(r) || !r.every((n) => typeof n === 'string' && n)) {
        bad('a rate limit that is not a list of names');
      }
      if (new Set(r as string[]).size !== (r as string[]).length) bad('a rate limit named twice');
    }
  }

  if (own('audit')) {
    // The generic audit row is written for a mutating method or a row that
    // writes (route-scope.ts auditsAsWrite): `audit` says something only
    // there.
    if (d.audit !== 'own' || !(writes || auditsByMethod(method))) {
      bad("audit: 'own', on a row that audits as a write only");
    }
  }
  return d as MethodPolicy;
}

/**
 * Check a route file's whole declaration: an object of methods, each one
 * the file exports (`methods`, the manifest entry's), each method's policy
 * valid (validateMethodPolicy). Returns the checked copies, typed.
 */
export function validateRoutePolicy(
  raw: unknown,
  pattern: string,
  methods: readonly string[],
): RoutePolicyDeclaration {
  // Read once (dataCopy): what is returned is what was checked.
  const copy = dataCopy(raw) as Readonly<Record<string, unknown>>;
  const shape = exactObject(copy, DECLARED_METHODS);
  if (shape) throw new Error(`ROUTE_POLICY: ${pattern} declares a policy that ${shape}`);
  const out = Object.create(null) as Record<string, MethodPolicy>;
  for (const m of Object.keys(copy)) {
    if (!methods.includes(m)) {
      throw new Error(
        `ROUTE_POLICY: ${pattern} declares a policy for ${m}, which it does not serve`,
      );
    }
    Object.defineProperty(out, m, {
      value: validateMethodPolicy(copy[m], pattern, m),
      enumerable: true,
    });
  }
  return Object.freeze(out) as RoutePolicyDeclaration;
}
