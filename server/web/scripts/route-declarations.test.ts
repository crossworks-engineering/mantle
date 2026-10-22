/**
 * The route policy codemod's core (route-declarations.ts) and the
 * generator's reader of a declaration (route-callers.ts handlerPolicy),
 * plan v3.2 S9: the text written into a route file, where it goes, that a
 * second run changes nothing, and that the generator reads back exactly
 * the declaration written (and refuses what is not data).
 */
import { describe, expect, it } from 'vitest';
import { ITEM_NONE_PLACEHOLDER, type RoutePolicyDeclaration } from '../lib/auth/route-declaration';
import { buildRouteRow, type RouteCaller } from '../lib/auth/route-policy';
import { aliasMismatches, handlerPolicy, reExportedHandlers } from './route-callers';
import {
  CannotExpress,
  OWN_THINGS,
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

  it("a 'self' write's reason only where its path names nothing of another party's (MED-1)", () => {
    // Each row with the caller its handler reads (the rows snapshot's).
    const reason = (method: string, pattern: string, reads: RouteCaller) =>
      itemNoneReason(buildRouteRow(method, pattern, () => false, { reads }));
    const SELF = "the login's own things, not an item";
    // No path param, and no item in the body: the login's own things.
    expect(reason('PUT', '/api/profile', 'owner')).toBe(SELF);
    expect(reason('POST', '/api/auth/logout', 'publicLogin')).toBe(SELF);
    // A param that is one of its own things: named for what it is.
    expect(reason('DELETE', '/api/access-keys/:id', 'login')).toBe(
      OWN_THINGS['/api/access-keys/:id'],
    );
    expect(reason('DELETE', '/api/telegram/my-chats/:id', 'chat')).toMatch(/own Telegram chats/);
    // Another party's item in the path, or in the body: not decided yet.
    for (const [m, p, reads] of [
      ['POST', '/api/grants/:nodeId', 'login'],
      ['PATCH', '/api/workspaces/:id/users/:loginId', 'login'],
      ['POST', '/api/assistant/threads/:id/continue', 'chat'],
      ['POST', '/api/telegram/chats/:id/block', 'chat'],
      ['POST', '/api/grants/move', 'login'],
    ] as const) {
      expect(reason(m, p, reads), `${m} ${p}`).toBe(ITEM_NONE_PLACEHOLDER);
    }
  });

  it('states an effect exception with the reason of its own route', () => {
    const evaluate = buildRouteRow('POST', '/api/formulas/:id/evaluate', () => false, {
      reads: 'owner',
    });
    expect(rowDeclaration(evaluate).effect).toEqual({
      read: "a formula's calculator: it evaluates and stores nothing",
    });
    const ms = buildRouteRow('GET', '/api/microsoft/oauth/callback', () => false, {
      reads: 'owner',
    });
    expect(rowDeclaration(ms).effect).toEqual({ write: expect.stringMatching(/^the Microsoft/) });
  });

  it('names a row it cannot say, and writes nothing for it', () => {
    const row = buildRouteRow('GET', '/s/:token', () => false, { page: 'link' });
    expect(() => rowDeclaration(row)).toThrow(CannotExpress);
    expect(() => rowDeclaration(row)).toThrow(/a page of server\/pages/);
  });
});

describe('an alias is the route its file re-exports (LOW-1)', () => {
  const ALIAS_FILE = 'app/api/v1/notes/route.ts';
  const src = (decl: string, head = "export { GET, POST } from '../../notes/route';\n") =>
    `${IMPORT}\n${head}${decl}\n`;
  const patternOf = (spec: string) =>
    spec === '../../notes/route'
      ? '/api/notes'
      : spec === '../../pages/route'
        ? '/api/pages'
        : null;
  const V1 = { pattern: '/api/v1/notes', methods: ['GET', 'POST'] };
  const read = (text: string) => handlerPolicy(text, ALIAS_FILE, V1);

  it('reads the handlers a file takes unchanged, and not one it wraps', () => {
    expect(
      reExportedHandlers(
        [
          "import { PATCH as patch } from '../../pages/[id]/route';",
          "import { DELETE } from '../../notes/[id]/route';",
          "export { GET, routeParams } from '../../notes/route';",
          "export { GET as HEAD } from '../../notes/route';",
          'export { DELETE };',
          'export async function PATCH(req: Request) { return patch(req); }',
        ].join('\n'),
        ALIAS_FILE,
      ),
    ).toEqual({
      GET: { spec: '../../notes/route', name: 'GET' },
      HEAD: { spec: '../../notes/route', name: 'GET' },
      DELETE: { spec: '../../notes/[id]/route', name: 'DELETE' },
    });
  });

  it('holds where each declared alias is the re-exported route', () => {
    const text = src(
      `export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'notes', aliasOf: 'GET /api/notes' },
  POST: { class: 'content', keyArea: 'notes', item: { none: 'x' }, aliasOf: 'POST /api/notes' },
});`,
    );
    expect(aliasMismatches(text, ALIAS_FILE, read(text), patternOf)).toEqual([]);
  });

  it('refuses an alias of another route, a missing one, and one with a handler of its own', () => {
    const other = src(
      `export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'notes', aliasOf: 'GET /api/pages' },
  POST: { class: 'content', keyArea: 'notes', item: { none: 'x' } },
});`,
    );
    expect(aliasMismatches(other, ALIAS_FILE, read(other), patternOf)).toEqual([
      `${ALIAS_FILE}: GET declares aliasOf GET /api/pages, but re-exports GET /api/notes`,
      `${ALIAS_FILE}: POST re-exports the handler of POST /api/notes and declares no aliasOf`,
    ]);
    const own = src(
      "export const policy = routePolicy({ GET: { class: 'content', keyArea: 'notes', aliasOf: 'GET /api/notes' } });",
      'export async function GET() {}\n',
    );
    const ownRead = handlerPolicy(own, ALIAS_FILE, { pattern: '/api/v1/notes', methods: ['GET'] });
    expect(aliasMismatches(own, ALIAS_FILE, ownRead, patternOf)).toEqual([
      `${ALIAS_FILE}: GET declares aliasOf GET /api/notes and re-exports no route's handler`,
    ]);
    // No declaration: nothing to hold (lists mode).
    expect(aliasMismatches(other, ALIAS_FILE, null, patternOf)).toEqual([]);
  });
});
