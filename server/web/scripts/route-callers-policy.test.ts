/**
 * The generator's reader of a route file's declaration (route-callers.ts
 * handlerPolicy), plan v3.2 S9: it reads exactly the declaration written,
 * refuses what is not data, and holds an alias to the route its file
 * re-exports. (The codemod that wrote the declarations from the route
 * lists went with the lists, S9 part 3; these cells were its test's.)
 */
import { describe, expect, it } from 'vitest';
import {
  aliasMismatches,
  handlerPolicy,
  reExportedHandlers,
  routeFilePattern,
  specPattern,
  specRouteFile,
} from './route-callers';

/** The route of `file`, as the manifest entry says it. */
const ROUTE = { pattern: '/api/notes', methods: ['GET', 'POST'] };
const IMPORT = "import { routePolicy } from '@/lib/auth/route-declaration';";
const file = 'app/api/notes/route.ts';

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
    // A method the file exports and the declaration does not name (S9 part
    // 3 round 2, the flip audit): refused here, as at the boot.
    refuses("export const policy = routePolicy({ GET: { class: 'content' } });", /names no POST/);
    refuses(
      "export const policy = routePolicy({ POST: { class: 'content', item: { none: 'x' } } });",
      /names no GET, which the file exports/,
    );
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

describe('an alias is the route its file re-exports (LOW-1)', () => {
  const ALIAS_FILE = 'app/api/v1/notes/route.ts';
  const src = (decl: string, head = "export { GET, POST } from '../../notes/route';\n") =>
    `${IMPORT}\n${head}${decl}\n`;
  // The one resolver (route-callers.ts specPattern) over a tree of these
  // files.
  const FILES = new Set([
    ALIAS_FILE,
    'app/api/notes/route.ts',
    'app/api/pages/route.ts',
    'app/api/notes/[id]/route.ts',
    'lib/notes.ts',
  ]);
  const exists = (f: string) => FILES.has(f);
  const patternOf = (spec: string) => specPattern(ALIAS_FILE, spec, exists);
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

  it('one resolver of a spec to its route pattern', () => {
    expect(patternOf('../../notes/route')).toBe('/api/notes');
    expect(patternOf('../../notes/[id]/route')).toBe('/api/notes/:id');
    expect(patternOf('../../notes/route.ts')).toBe('/api/notes');
    // A lib module, a package, a file that is not there: no route file.
    expect(specRouteFile(ALIAS_FILE, '../../../../lib/notes', exists)).toBeNull();
    expect(specRouteFile(ALIAS_FILE, '../../notes/route', exists)).toBe('app/api/notes/route.ts');
    expect(patternOf('../../../../lib/notes')).toBeNull();
    expect(patternOf('@mantle/std')).toBeNull();
    expect(patternOf('@/lib/notes')).toBeNull();
    expect(patternOf('../../gone/route')).toBeNull();
    // The pattern of a route file: groups dropped, params, catch-alls.
    expect(routeFilePattern('app/(api)/api/x/[id]/route.ts')).toBe('/api/x/:id');
    expect(routeFilePattern('app/api/files/[...path]/route.ts')).toBe('/api/files/*');
    expect(routeFilePattern('app/api/f/[[...path]]/route.tsx')).toBe('/api/f/*');
    expect(routeFilePattern('lib/route.ts')).toBeNull();
  });

  it('refuses a route file named by a path that is not relative', () => {
    for (const spec of ['@/app/api/notes/route', '@/app/api/notes/route.ts', '/abs/app/route']) {
      expect(() => patternOf(spec), spec).toThrow(/by a path that is not relative/);
    }
    // The alias check reports it as a mismatch: the generator and the
    // codemod refuse the file.
    const text = src(
      "export const policy = routePolicy({ GET: { class: 'content', keyArea: 'notes', aliasOf: 'GET /api/notes' } });",
      "export { GET } from '@/app/api/notes/route';\n",
    );
    const policy = handlerPolicy(text, ALIAS_FILE, { pattern: '/api/v1/notes', methods: ['GET'] });
    expect(aliasMismatches(text, ALIAS_FILE, policy, patternOf)).toEqual([
      expect.stringMatching(
        /imports the route file @\/app\/api\/notes\/route by a path that is not relative/,
      ),
    ]);
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
