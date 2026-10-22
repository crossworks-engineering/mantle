/**
 * The route policy codemod's core (route-declarations.ts) and the
 * generator's reader of a declaration (route-callers.ts handlerPolicy),
 * plan v3.2 S9: the text written into a route file, where it goes, that a
 * second run changes nothing, and that the generator reads back exactly
 * the declaration written (and refuses what is not data).
 */
import { describe, expect, it } from 'vitest';
import { ITEM_NONE_PLACEHOLDER, type RoutePolicyDeclaration } from '../lib/auth/route-declaration';
import { buildRouteRow } from '../lib/auth/route-policy';
import { handlerPolicy } from './route-callers';
import {
  CannotExpress,
  applyDeclaration,
  itemNoneReason,
  renderDeclaration,
  rowDeclaration,
} from './route-declarations';

const DECL: RoutePolicyDeclaration = {
  GET: { class: 'content', open: 'owner' },
  POST: {
    class: 'content',
    open: 'owner',
    creates: true,
    item: { none: 'creates an item: ?ws= names where it lands' },
    limits: { crossSite: 'json', rateLimit: ['authLogin'] },
  },
};
/** The route of `file`, as the manifest entry says it. */
const ROUTE = { pattern: '/api/notes', methods: ['GET', 'POST'] };
const IMPORT = "import { routePolicy } from '@/lib/auth/route-declaration';";
const file = 'app/api/notes/route.ts';

describe('renderDeclaration', () => {
  it('writes one method a line, literals only, in method order', () => {
    expect(renderDeclaration({ POST: DECL.POST!, GET: DECL.GET! })).toBe(
      [
        'export const policy = routePolicy({',
        "  GET: { class: 'content', open: 'owner' },",
        "  POST: { class: 'content', open: 'owner', creates: true, item: { none: 'creates an item: ?ws= names where it lands' }, limits: { crossSite: 'json', rateLimit: ['authLogin'] } },",
        '});',
      ].join('\n'),
    );
  });
});

describe('applyDeclaration', () => {
  const statement = renderDeclaration(DECL);

  it('goes after routeParams, imports routePolicy after the last import, and is idempotent', () => {
    const src = [
      "import { ownerCaller } from '@/lib/auth';",
      "import type { RouteParams } from '@/lib/route-params';",
      '',
      "export const routeParams = { id: 'uuid' } as const satisfies RouteParams;",
      '',
      'export async function GET() {}',
      'export async function POST() {}',
      '',
    ].join('\n');
    const once = applyDeclaration(src, file, statement);
    expect(once).toBe(
      [
        "import { ownerCaller } from '@/lib/auth';",
        "import type { RouteParams } from '@/lib/route-params';",
        IMPORT,
        '',
        "export const routeParams = { id: 'uuid' } as const satisfies RouteParams;",
        '',
        statement,
        '',
        'export async function GET() {}',
        'export async function POST() {}',
        '',
      ].join('\n'),
    );
    expect(applyDeclaration(once, file, statement)).toBe(once);
    expect(handlerPolicy(once, file, ROUTE)).toEqual(DECL);
  });

  it('goes after the imports when there is no routeParams, at the end when there is no import', () => {
    const withImports = applyDeclaration(
      "import { ownerCaller } from '@/lib/auth';\nexport async function GET() {}\n",
      file,
      renderDeclaration({ GET: DECL.GET! }),
    );
    expect(withImports.split('\n').slice(0, 3)).toEqual([
      "import { ownerCaller } from '@/lib/auth';",
      IMPORT,
      '',
    ]);
    const alias = "/** v1: the same handler. */\nexport { GET } from '../../notes/route';\n";
    const out = applyDeclaration(alias, file, renderDeclaration({ GET: DECL.GET! }));
    expect(out.startsWith(`${IMPORT}\n/** v1`)).toBe(true);
    expect(out.trimEnd().endsWith('});')).toBe(true);
    expect(handlerPolicy(out, file, { pattern: '/api/notes', methods: ['GET'] })).toEqual({
      GET: DECL.GET,
    });
  });

  it('replaces a declaration that is not what the lists say, and keeps the one import', () => {
    const old = applyDeclaration(
      'export async function GET() {}\nexport async function POST() {}\n',
      file,
      renderDeclaration({ GET: DECL.GET!, POST: { class: 'content', item: { none: 'x' } } }),
    );
    const now = applyDeclaration(old, file, renderDeclaration(DECL));
    expect(handlerPolicy(now, file, ROUTE)).toEqual(DECL);
    expect(now.split(IMPORT).length).toBe(2);
  });
});

describe('handlerPolicy', () => {
  const src = (decl: string, extra = '') =>
    `${IMPORT}\n${extra}export async function GET() {}\nexport async function POST() {}\n${decl}\n`;
  const V1 = { pattern: '/api/v1/x', methods: ['GET', 'POST'] };

  it('reads none where the file declares none', () => {
    expect(handlerPolicy('export async function GET() {}\n', file, ROUTE)).toBeNull();
  });

  it('reads the literals of a declaration, prettier-wrapped or not', () => {
    const text = `export const policy = routePolicy({
  GET: { class: 'content', keyArea: null, aliasOf: \`GET /api/x\` },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area' },
    limits: { rateLimit: ['authLogin', 'authSignup'] },
  },
});`;
    const read = handlerPolicy(src(text), file, V1);
    expect(read).toEqual({
      GET: { class: 'content', keyArea: null, aliasOf: 'GET /api/x' },
      POST: {
        class: 'area',
        area: 'settings',
        item: { none: 'manages the settings area' },
        limits: { rateLimit: ['authLogin', 'authSignup'] },
      },
    });
    // Data with no prototype: a key is only ever a key.
    expect(Object.getPrototypeOf(read!.POST)).toBeNull();
  });

  it('refuses what is not data, or not written out', () => {
    const refuses = (text: string, why: RegExp, extra = '') =>
      expect(() => handlerPolicy(src(text, extra), file, ROUTE)).toThrow(why);
    refuses("export let policy = routePolicy({ GET: { class: 'content' } });", /let or var/);
    refuses("export const policy = { GET: { class: 'content' } };", /not routePolicy/);
    refuses('export const policy = routePolicy({ GET: X });', /not a literal/);
    refuses(
      "export const policy = routePolicy({ GET: { ...base, class: 'content' } });",
      /written out/,
    );
    refuses("export const policy = routePolicy({ [m]: { class: 'content' } });", /computed key/);
    refuses(
      "export const policy = routePolicy({ GET: { class: 'content', class: 'self' } });",
      /named twice/,
    );
    refuses(
      "export const policy = routePolicy({ GET: { class: 'content', __proto__: { open: 'any' } } });",
      /__proto__ is no key/,
    );
    refuses(
      "export const policy = routePolicy({ GET: { class: 'content', limits: { __proto__: null } } });",
      /__proto__ is no key/,
    );
    refuses("export const policy = routePolicy({ PUT: { class: 'content' } });", /does not serve/);
    refuses("export const policy = routePolicy({ GOT: { class: 'content' } });", /key GOT/);
    refuses(
      'export const policy = routePolicy({ GET: { limits: { rateLimit: [...names] } } });',
      /spread/,
    );
    refuses('const p = {};\nexport { p as policy };', /exported by name/);
    // The one validator (route-declaration.ts validateMethodPolicy) runs here.
    refuses(
      "export const policy = routePolicy({ GET: { class: 'content', effect: 'read' } });",
      /effect that is not/,
    );
    refuses(
      "export const policy = routePolicy({ POST: { class: 'content' } });",
      /no item: a write/,
    );
    refuses(
      "export const policy = routePolicy({ POST: { class: 'content', item: { none: 'x' }, limits: null } });",
      /limits that is no object/,
    );
    expect(() =>
      handlerPolicy(
        "export async function GET() {}\nexport const policy = routePolicy({ GET: { class: 'content' } });\n",
        file,
        ROUTE,
      ),
    ).toThrow(/no import of it/);
    expect(() =>
      handlerPolicy(
        "import { routePolicy as rp } from '@/lib/auth/route-declaration';\nexport async function GET() {}\nexport const policy = rp({ GET: {} });\n",
        file,
        ROUTE,
      ),
    ).toThrow(/by its own name/);
  });
});

describe('rowDeclaration', () => {
  it('says a row in the fields that are not its default', () => {
    const row = buildRouteRow('GET', '/api/workspaces', () => false, { reads: 'login' });
    expect(rowDeclaration(row)).toEqual({ class: 'self', scope: null, open: 'any' });
    // A write says its item, with the reason its facts give.
    const write = buildRouteRow('POST', '/api/notes', () => false, { reads: 'owner' });
    expect(rowDeclaration(write)).toMatchObject({
      class: 'content',
      creates: true,
      item: { none: 'creates an item: ?ws= names where it lands' },
    });
    expect(
      itemNoneReason(buildRouteRow('PATCH', '/api/notes/:id', () => false, { reads: 'owner' })),
    ).toBe(ITEM_NONE_PLACEHOLDER);
  });

  it('names a row it cannot say, and writes nothing for it', () => {
    const row = buildRouteRow('GET', '/s/:token', () => false, { page: 'link' });
    expect(() => rowDeclaration(row)).toThrow(CannotExpress);
    expect(() => rowDeclaration(row)).toThrow(/a page of server\/pages/);
  });
});
