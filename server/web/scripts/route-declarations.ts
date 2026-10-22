/**
 * The route policy codemod's core (plan v3.2, the route declarations; the CLI is
 * scripts/route-policy-codemod.ts): the declaration a route file's methods
 * get from today's lists (rowDeclaration, entryDeclaration), its text
 * (renderDeclaration), and that text written into the file
 * (applyDeclaration). No file is read or written here, so the tests drive
 * it whole: route-policy-declarations.test.ts builds every row from the
 * declarations derived here and finds it equal to the lists' row.
 */
import ts from 'typescript';
import {
  DECLARED_METHODS,
  ITEM_NONE_PLACEHOLDER,
  NAMED_CALLERS,
  ROUTE_POLICY_EXPORT,
  methodEffect,
  type DeclaredMethod,
  type MethodPolicy,
  type RoutePolicyDeclaration,
} from '../lib/auth/route-declaration';
import { READ_POSTS, WRITE_GETS } from '../lib/auth/route-scope';
import { API_V1_ROUTES } from '../lib/api-v1';
import { servedMethods, type RouteManifestEntry, type RouteRow } from '../lib/auth/route-policy';

/** The module a route file imports routePolicy from (its own name). */
export const ROUTE_DECLARATION_MODULE = '@/lib/auth/route-declaration';

/** A row the declaration shape cannot say: the codemod writes nothing for
 *  its file and names it. */
export class CannotExpress extends Error {
  constructor(
    readonly key: string,
    readonly why: string,
  ) {
    super(`${key}: ${why}`);
    this.name = 'CannotExpress';
  }
}

/** The path param at segment `seg` of `pattern` (`:id` is `id`). */
function paramAt(pattern: string, seg: number): string | null {
  const s = pattern.split('/')[seg];
  return s?.startsWith(':') ? s.slice(1) : null;
}

/** Why a row's effect is not its method's, by the list that says it
 *  (route-scope.ts READ_POSTS, WRITE_GETS): the declaration states the
 *  exception with its reason. */
const EFFECT_REASONS: Readonly<Record<'read' | 'write', string>> = {
  read: "a formula's calculator: it evaluates and stores nothing",
  write: "a connector's OAuth callback: it stores the tokens it was given",
};

/**
 * Why a write names no item (`item: { none }`), from the row's facts where
 * they say it; else ITEM_NONE_PLACEHOLDER, which the lint can forbid once
 * each is decided. No row of the lists has an item check today
 * (route-scope.ts itemWriteTarget).
 */
export function itemNoneReason(row: RouteRow): string {
  switch (row.class) {
    case 'public':
      return 'a public route: it judges its own credential';
    case 'link':
      return 'a link route: its share token names what it opens';
    case 'self':
      return "the login's own things, not an item";
    case 'area':
      return `manages the ${row.area} area: the Admin step checks it`;
    default:
      break;
  }
  const params = row.pattern.split('/').filter((s) => s.startsWith(':'));
  if (params.length === 0) {
    return row.creates ? 'creates an item: ?ws= names where it lands' : 'names no item in its path';
  }
  return ITEM_NONE_PLACEHOLDER;
}

/** The base a v1 row with a handler of its own admits a login as
 *  (api-v1.ts API_V1_ROUTES `base`), where it is no alias. */
function v1Base(row: RouteRow): string | null {
  if (!row.pattern.startsWith('/api/v1/') || row.aliasOf) return null;
  const m = row.method === 'HEAD' ? 'GET' : row.method;
  return API_V1_ROUTES.find((r) => r.method === m && r.pattern === row.pattern)?.base ?? null;
}

/**
 * The declaration of one row's method: the fields of the row the lists
 * decide, each written only where it is not what the shape leaves out
 * (the effect is the method's; no `open`: Admin only; no `creates`;
 * makesItems as a write makes; no key area, limits, alias or base; the
 * item only on a write). What the manifest decides (the caller, a gone
 * stub, a switch) and what the row derives (cors, the render cookie,
 * startsAs, the actor) are not declared, but a named caller kind is
 * (NAMED_CALLERS), and the boot checks it against the manifest's. An alias
 * and a v1 row with a base take their open, creates (and an alias its
 * limits) from the base's declaration, so they declare none of them.
 */
export function rowDeclaration(row: RouteRow): MethodPolicy {
  const no = (why: string): never => {
    throw new CannotExpress(row.key, why);
  };
  if (row.page) no('a page of server/pages: no route file to declare it in');
  const scopeKind = row.scope?.kind ?? null;
  const d: Record<string, unknown> = { class: row.class };
  switch (row.class) {
    case 'area':
      if (scopeKind !== 'area' || row.area === null) no('an area row whose scope is no area');
      d.area = row.area;
      if (row.public) d.public = true;
      break;
    case 'content':
      if (scopeKind !== 'content') no('a content row whose scope is not content');
      if (row.public) no('a public content row');
      break;
    case 'self':
      if (scopeKind !== 'self' && scopeKind !== null) no(`a self row of scope ${scopeKind}`);
      if (row.public) d.public = true;
      if (scopeKind === null) d.scope = null;
      break;
    case 'public':
    case 'link':
      if (scopeKind !== null) no(`a ${row.class} row with the scope ${scopeKind}`);
      if (!row.public) no(`a ${row.class} row the gate does not let in`);
      break;
    default:
      no(`the class ${row.class}`);
  }
  if (row.effect !== methodEffect(row.method)) {
    const listed =
      row.effect === 'read' ? READ_POSTS.has(row.key) : WRITE_GETS.has(`GET ${row.pattern}`);
    if (!listed) no(`the effect ${row.effect} on a ${row.method}, which no list says`);
    d.effect = { [row.effect]: EFFECT_REASONS[row.effect] };
  }
  const base = row.aliasOf ?? v1Base(row);
  if (row.logins && !base) d.open = row.logins;
  if (row.caller && (NAMED_CALLERS as readonly string[]).includes(row.caller)) {
    d.caller = row.caller;
  }
  if (row.creates && !base) d.creates = true;
  if (!row.makesItems && row.method !== 'DELETE') d.makesItems = false;
  if (row.item) {
    const param = paramAt(row.pattern, row.item.seg);
    if (!param) no('an item outside a path param');
    if (row.item.ref !== 'node') no(`an item named through ${row.item.ref}`);
    d.item = { param, need: row.item.need };
  } else if (row.effect === 'write') {
    d.item = { none: itemNoneReason(row) };
  }
  if (row.keyArea !== undefined) {
    if (row.keySelf && row.keyArea !== null) no('a key row about the key itself with an area');
    d.keyArea = row.keySelf ? 'self' : row.keyArea;
  }
  if ((row.crossSite || row.rateLimit.length) && !row.aliasOf) {
    d.limits = {
      ...(row.crossSite ? { crossSite: row.crossSite } : {}),
      ...(row.rateLimit.length ? { rateLimit: [...row.rateLimit] } : {}),
    };
  }
  if (row.aliasOf) d.aliasOf = row.aliasOf;
  else if (base) d.base = base;
  if (row.audit) d.audit = row.audit;
  return d as MethodPolicy;
}

/**
 * The declaration of a route file: each method it exports to its row's
 * declaration (rowDeclaration). A HEAD the GET handler answers is GET's
 * row, so it is not declared; a route that exports its own HEAD declares
 * it. `table` is the lists' ROUTE_POLICY.
 */
export function entryDeclaration(
  table: ReadonlyMap<string, RouteRow>,
  entry: Pick<RouteManifestEntry, 'pattern' | 'methods'>,
): RoutePolicyDeclaration {
  const out: Partial<Record<DeclaredMethod, MethodPolicy>> = {};
  const exported = new Set(servedMethods(entry).filter((m) => entry.methods.includes(m)));
  for (const m of DECLARED_METHODS) {
    if (!exported.has(m)) continue;
    const row = table.get(`${m} ${entry.pattern}`);
    if (!row) throw new CannotExpress(`${m} ${entry.pattern}`, 'no row');
    out[m] = rowDeclaration(row);
  }
  return out as RoutePolicyDeclaration;
}

/** A value of a declaration as source text (literals only, single quotes). */
function literal(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(literal).join(', ')}]`;
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>).map(
      ([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : literal(k)}: ${literal(x)}`,
    );
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  throw new Error(`renderDeclaration: ${String(v)} is no literal`);
}

/** The declaration's statement, one method a line (prettier may wrap a
 *  long one; the generator reads either). */
export function renderDeclaration(decl: RoutePolicyDeclaration): string {
  const lines = DECLARED_METHODS.flatMap((m) => (decl[m] ? [`  ${m}: ${literal(decl[m])},`] : []));
  return `export const ${ROUTE_POLICY_EXPORT} = routePolicy({\n${lines.join('\n')}\n});`;
}

/**
 * `src` with the declaration statement `statement` (renderDeclaration):
 * an existing `export const policy` is replaced, else the statement goes
 * after `export const routeParams`, else after the last import, else at
 * the end; and routePolicy is imported from ROUTE_DECLARATION_MODULE
 * unless it is. The same text again changes nothing (idempotent).
 */
export function applyDeclaration(src: string, file: string, statement: string): string {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let existing: ts.Statement | null = null;
  let params: ts.Statement | null = null;
  let lastImport: ts.ImportDeclaration | null = null;
  let imported = false;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      lastImport = st;
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      const named = st.importClause?.namedBindings;
      if (
        spec === ROUTE_DECLARATION_MODULE &&
        named &&
        ts.isNamedImports(named) &&
        named.elements.some((e) => !e.propertyName && e.name.text === 'routePolicy')
      ) {
        imported = true;
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (d.name.text === ROUTE_POLICY_EXPORT) existing = st;
        if (d.name.text === 'routeParams') params = st;
      }
    }
  }
  const edits: Array<{ at: number; end: number; text: string }> = [];
  if (existing) {
    const at = existing.getStart(sf);
    if (src.slice(at, existing.getEnd()) !== statement) {
      edits.push({ at, end: existing.getEnd(), text: statement });
    }
  } else {
    const after = params ?? lastImport;
    if (after) edits.push({ at: after.getEnd(), end: after.getEnd(), text: `\n\n${statement}` });
    else edits.push({ at: src.length, end: src.length, text: `\n${statement}\n` });
  }
  if (!imported) {
    const line = `import { routePolicy } from '${ROUTE_DECLARATION_MODULE}';`;
    if (lastImport) {
      edits.push({ at: lastImport.getEnd(), end: lastImport.getEnd(), text: `\n${line}` });
    } else edits.push({ at: 0, end: 0, text: `${line}\n` });
  }
  let out = src;
  for (const e of edits.sort((a, b) => b.at - a.at || b.end - a.end)) {
    out = out.slice(0, e.at) + e.text + out.slice(e.end);
  }
  return out;
}
