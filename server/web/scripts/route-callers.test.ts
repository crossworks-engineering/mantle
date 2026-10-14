/** Which handlers read the caller the pipeline answers (arch A4 step 3b). */
import { describe, expect, it } from 'vitest';
import { handlerReads } from './route-callers';

const IMPORT = `import { ownerCaller } from '@/lib/auth';`;
/** The base route a v1 file wraps: its GET reads the caller. */
const follow = (spec: string) => (spec === '../../notes/route' ? ['GET'] : null);
const reads = (src: string) => handlerReads(src, 'x/route.ts', follow);

describe('handlerReads', () => {
  it('names each exported handler that reads the owner caller', () => {
    const src = `
      import { ownerCaller, getOwnerForAsset } from '@/lib/auth';
      export async function PUT(req: Request) {
        const owner = ownerCaller();
        return Response.json(owner);
      }
      export const DELETE = async () => {
        ownerCaller();
        return new Response(null, { status: 204 });
      };
      export async function GET(req: Request) {
        const user = await getOwnerForAsset(req);
        return user instanceof Response ? user : Response.json(user);
      }
    `;
    expect(handlerReads(src, 'a/route.ts')).toEqual(['DELETE', 'PUT']);
  });

  it('follows a handler exported under another name', () => {
    const src = `${IMPORT}
      async function handle() { const o = ownerCaller(); return Response.json(o); }
      export { handle as GET, handle as POST };
      export const PUT = handle;
    `;
    expect(handlerReads(src, 'a/route.ts')).toEqual(['GET', 'POST', 'PUT']);
  });

  it('follows a handler another route file exports, re-exported or wrapped', () => {
    const base: Record<string, readonly string[]> = { '../../notes/route': ['GET'] };
    const follow = (spec: string) => base[spec] ?? null;
    const src = `
      import { GET as notes } from '../../notes/route';
      export { GET } from '../../notes/route';
      export { POST } from '../../notes/route';
      export async function PATCH(req: Request, ctx: unknown) { return notes(req, ctx); }
      export const PUT = (req: Request) => notes(req);
      export { DELETE } from '@/lib/elsewhere';
    `;
    expect(handlerReads(src, 'a/route.ts', follow)).toEqual(['GET', 'PATCH', 'PUT']);
    // Without knowing the other file, nothing it exports is taken as read.
    expect(handlerReads(src, 'a/route.ts')).toEqual([]);
  });

  it('reads none where no handler reads it', () => {
    expect(handlerReads(`export const GET = gone('owner');`, 'a/route.ts')).toEqual([]);
  });

  it('refuses a handler that reads it and calls a guard too', () => {
    const src = `
      import { ownerCaller, getOwnerOr401 } from '@/lib/auth';
      export async function GET() {
        const a = ownerCaller();
        const b = await getOwnerOr401();
        return Response.json({ a, b });
      }
    `;
    expect(() => handlerReads(src, 'a/route.ts')).toThrow(/also calls getOwnerOr401/);
  });

  it('refuses a read outside an exported handler', () => {
    const src = `${IMPORT}
      function who() { return ownerCaller(); }
      export async function GET() { return Response.json(who()); }
    `;
    expect(() => handlerReads(src, 'a/route.ts')).toThrow(
      /a\/route\.ts:2: ownerCaller\(\) outside/,
    );
  });

  // ── L3: code before the read or the wrapped call ──────────────────────────

  it('refuses a wrapper with code before the wrapped call (the v1 pages PATCH shape)', () => {
    const src = `
      import { GET as notes } from '../../notes/route';
      export async function GET(req: Request, ctx: unknown) {
        if (await hiddenFromKey(req)) return Response.json({ error: 'not found' }, { status: 404 });
        return notes(req, ctx);
      }
    `;
    expect(() => reads(src)).toThrow(/GET runs code before it reads the caller/);
    // Arguments that run code run before the call too.
    expect(() =>
      reads(`import { GET as notes } from '../../notes/route';
        export async function GET(req: Request) { return notes(new Request(req.url)); }`),
    ).toThrow(/runs code before/);
  });

  it('takes a wrapper marked as a hand case', () => {
    const src = `
      import { GET as notes } from '../../notes/route';
      // route-callers: hand case (the 404 is the key's, checked by hand)
      export async function GET(req: Request, ctx: unknown) {
        if (await hiddenFromKey(req)) return Response.json({ error: 'not found' }, { status: 404 });
        return notes(req, ctx);
      }
    `;
    expect(reads(src)).toEqual(['GET']);
  });

  it('refuses a handler with code before its read', () => {
    const src = `${IMPORT}
      export async function GET(req: Request) {
        if (!flagOn()) return new Response(null, { status: 404 });
        const owner = ownerCaller();
        return Response.json(owner);
      }
    `;
    expect(() => reads(src)).toThrow(/GET runs code before it reads the caller/);
  });

  it('refuses a reading handler whose parameters run code (a default value)', () => {
    const cases = [
      `${IMPORT}
       export async function GET(req: Request, ctx: unknown, x = audit()) { const o = ownerCaller(); return Response.json({ o, x }); }`,
      `${IMPORT}
       export async function GET(req: Request, { params = sideFx() }: any) { const o = ownerCaller(); return Response.json({ o, params }); }`,
      `${IMPORT}
       export const GET = async (req: Request, { a: [b = sideFx()] }: any) => ownerCaller();`,
      `${IMPORT}
       export async function GET(req: Request, { [key()]: v }: any) { const o = ownerCaller(); return Response.json({ o, v }); }`,
      `import { GET as notes } from '../../notes/route';
       export async function GET(req: Request, ctx = audit()) { return notes(req, ctx); }`,
    ];
    for (const src of cases) expect(() => reads(src)).toThrow(/GET runs code before it reads/);
    // A plain destructuring runs no code of its own; a hand case may.
    expect(
      reads(`${IMPORT}
        export async function GET(req: Request, { params }: { params: unknown }) { const o = ownerCaller(); return Response.json({ o, params }); }`),
    ).toEqual(['GET']);
    expect(
      reads(`${IMPORT}
        // route-callers: hand case (audit() checked by hand)
        export async function GET(req: Request, ctx: unknown, x = audit()) { const o = ownerCaller(); return Response.json({ o, x }); }`),
    ).toEqual(['GET']);
  });

  it('reads a handler that runs a reading handler of its own file (POST: return GET(req))', () => {
    expect(
      reads(`${IMPORT}
        export async function GET(req: Request) { const o = ownerCaller(); return Response.json(o); }
        export async function POST(req: Request) { return GET(req); }
        export const PUT = (req: Request) => POST(req);
        export async function DELETE() { return new Response(null, { status: 204 }); }`),
    ).toEqual(['GET', 'POST', 'PUT']);
    // Through another file's handler, wrapped here first.
    expect(
      reads(`import { GET as notes } from '../../notes/route';
        export async function GET(req: Request) { return notes(req); }
        export async function POST(req: Request) { return await GET(req); }`),
    ).toEqual(['GET', 'POST']);
    // A handler of the file that does not read is called freely.
    expect(
      reads(`${IMPORT}
        export async function GET() { return Response.json({}); }
        export async function POST() { if (x()) return GET(); return GET(); }`),
    ).toEqual([]);
  });

  it('refuses a local reading handler run with code first, passed on, or in a helper', () => {
    const head = `${IMPORT}
      export async function GET(req: Request) { const o = ownerCaller(); return Response.json(o); }`;
    expect(() =>
      reads(`${head}
        export async function POST(req: Request) { const body = await req.json(); return GET(req); }`),
    ).toThrow(/POST runs code before it reads/);
    expect(() =>
      reads(`${head}
        export async function POST(req: Request) { return GET(new Request(req.url)); }`),
    ).toThrow(/POST runs code before it reads/);
    expect(() =>
      reads(`${head}
        const withX = (h: any) => h;
        export const POST = withX(GET);`),
    ).toThrow(/passes GET \(a handler of this file that reads the caller\) other than calling it/);
    expect(() =>
      reads(`${head}
        function run(r: Request) { return GET(r); }
        export async function POST(req: Request) { return run(req); }`),
    ).toThrow(/GET\(\) outside an exported handler/);
    expect(() =>
      reads(`import { ownerCaller, getOwnerOr401 } from '@/lib/auth';
        export async function GET(req: Request) { const o = ownerCaller(); return Response.json(o); }
        export async function POST(req: Request) { return GET(req); await getOwnerOr401(); }`),
    ).toThrow(/POST reads the pipeline's caller and also calls getOwnerOr401/);
  });

  it('resolves a name to its binding: a parameter or local that shadows a handler is not it', () => {
    const head = `${IMPORT}
      export async function GET(req: Request) { const o = ownerCaller(); return Response.json(o); }`;
    // A parameter named GET: POST runs what it was passed, not the handler.
    expect(
      reads(`${head}
        export async function POST(req: Request, GET: () => Response) { return GET(); }`),
    ).toEqual(['GET']);
    // A local, a catch variable, an inner function: each its own binding.
    expect(
      reads(`${head}
        export async function POST(req: Request) { const GET = () => new Response(); return GET(); }
        export async function PUT(req: Request) { try { return x(); } catch (GET) { return f(GET); } }
        export async function DELETE() { function GET() { return new Response(); } return run(GET); }`),
    ).toEqual(['GET']);
    // The same for a reading handler imported from another route file.
    expect(
      reads(`import { GET as notes } from '../../notes/route';
        export async function GET(req: Request) { return notes(req); }
        export async function POST(req: Request, notes: (r: Request) => Response) { const r = new Request(req.url); return notes(r); }`),
    ).toEqual(['GET']);
    // The handler itself, beside a shadowed name, is still followed.
    expect(
      reads(`${head}
        export async function POST(req: Request) { return GET(req); }
        export async function PUT(req: Request, GET: unknown) { return Response.json(GET); }`),
    ).toEqual(['GET', 'POST']);
    // And still refused where it is passed on.
    expect(() =>
      reads(`${head}
        export async function POST(req: Request) { return Response.json({ GET }); }`),
    ).toThrow(/passes GET \(a handler of this file that reads the caller\) other than calling it/);
  });

  it('takes no name in a type as a use (type T = typeof GET)', () => {
    const head = `${IMPORT}
      export async function GET(req: Request) { const o = ownerCaller(); return Response.json(o); }`;
    expect(
      reads(`${head}
        type T = typeof GET;
        export async function POST(req: Request) { const h: typeof GET | null = null; return Response.json({ h } as unknown as ReturnType<T>); }`),
    ).toEqual(['GET']);
    expect(
      reads(`import { GET as notes } from '../../notes/route';
        export async function GET(req: Request) { return notes(req); }
        export type Notes = typeof notes;`),
    ).toEqual(['GET']);
    // typeof in a value is a use: refused as before.
    expect(() =>
      reads(`${head}
        export async function POST() { return Response.json(typeof GET); }`),
    ).toThrow(/passes GET/);
  });

  // ── L1: bindings, not names (the audit's mutation cases) ──────────────────

  const refused: Record<string, [src: string, error: RegExp]> = {
    aliasImport: [
      `import { ownerCaller as oc } from '@/lib/auth';
       export async function GET() { const u = oc(); return Response.json(u); }`,
      /imports ownerCaller as oc/,
    ],
    otherModule: [
      `import { ownerCaller } from '@/lib/who';
       export async function GET() { const u = ownerCaller(); return Response.json(u); }`,
      /imports ownerCaller from @\/lib\/who/,
    ],
    notImported: [
      `export async function GET() { const u = ownerCaller(); return Response.json(u); }`,
      /calls ownerCaller\(\) with no import/,
    ],
    aliasedGuardWithRead: [
      `import { ownerCaller, getOwnerOr401 as g } from '@/lib/auth';
       export async function PUT() { const u = ownerCaller(); const v = await g(); return Response.json({ u, v }); }`,
      /also calls getOwnerOr401/,
    ],
    aliasedGuardBesideRead: [
      `import { ownerCaller, getOwnerOr401 as g } from '@/lib/auth';
       export async function PUT() { const u = ownerCaller(); return Response.json(u); }
       export async function GET() { const v = await g(); return Response.json(v); }`,
      /imports getOwnerOr401 as g beside a read/,
    ],
    namespaceImport: [
      `import * as auth from '@/lib/auth';
       export async function GET() { return Response.json(auth.ownerCaller()); }`,
      /reads ownerCaller off an object/,
    ],
    elementAccess: [
      `import * as auth from '@/lib/auth';
       export async function GET() { return Response.json(auth['ownerCaller']()); }`,
      /reads ownerCaller off an object/,
    ],
    constRef: [
      `${IMPORT}
       const who = ownerCaller;
       export async function GET() { return Response.json(who()); }`,
      /names ownerCaller other than in a plain call/,
    ],
    bindCall: [
      `${IMPORT}
       export async function GET() { return Response.json(ownerCaller.call(null)); }`,
      /names ownerCaller other than in a plain call/,
    ],
    optionalCall: [
      `${IMPORT}
       export async function GET() { const u = ownerCaller?.(); return Response.json(u); }`,
      /names ownerCaller other than in a plain call/,
    ],
    dynImport: [
      `export async function GET() { const { ownerCaller } = await import('@/lib/auth'); return Response.json(ownerCaller()); }`,
      /names ownerCaller other than in a plain call/,
    ],
    shadowed: [
      `${IMPORT}
       export async function GET(ownerCaller: () => unknown) { const u = ownerCaller(); return Response.json(u); }`,
      /names ownerCaller other than in a plain call/,
    ],
    nestedFn: [
      `${IMPORT}
       export async function GET() { const f = () => ownerCaller(); return Response.json(f()); }`,
      /GET runs code before it reads/,
    ],
    hocLocal: [
      `${IMPORT}
       const withX = (h: any) => h;
       async function handler() { const u = ownerCaller(); return Response.json(u); }
       export const GET = withX(handler);`,
      /ownerCaller\(\) outside an exported handler/,
    ],
    hocInline: [
      `${IMPORT}
       const withX = (h: any) => h;
       export const GET = withX(async () => { const u = ownerCaller(); return Response.json(u); });`,
      /GET reads the caller but is not a plain function/,
    ],
    hocInlineGuardOutside: [
      `import { ownerCaller, getOwnerOr401 } from '@/lib/auth';
       const withAuth = (h: any) => async (r: Request) => { await getOwnerOr401(); return h(r); };
       export const GET = withAuth(async () => { const u = ownerCaller(); return Response.json(u); });`,
      /GET reads the caller but is not a plain function/,
    ],
    guardInHelperCalledByReader: [
      `import { ownerCaller, getOwnerOr401 } from '@/lib/auth';
       async function helper() { return getOwnerOr401(); }
       export async function GET() { const u = ownerCaller(); await helper(); return Response.json(u); }`,
      /calls getOwnerOr401 outside an exported handler/,
    ],
    guardRefBesideRead: [
      `import { ownerCaller, getOwnerOr401 } from '@/lib/auth';
       const g = getOwnerOr401;
       export async function GET() { const u = ownerCaller(); return Response.json(u); }`,
      /names getOwnerOr401 other than in a call/,
    ],
    exportDefault: [
      `${IMPORT}
       export default async function GET() { const u = ownerCaller(); return Response.json(u); }`,
      /ownerCaller\(\) outside an exported handler/,
    ],
    destructExport: [
      `${IMPORT}
       const h = { GET: async () => { const u = ownerCaller(); return Response.json(u); } };
       export const { GET } = h;`,
      /ownerCaller\(\) outside an exported handler/,
    ],
    letExport: [
      `${IMPORT}
       let GET2 = async () => { const u = ownerCaller(); return Response.json(u); };
       export { GET2 as GET };`,
      /GET reads the caller but is declared with let or var/,
    ],
    classMethod: [
      `${IMPORT}
       class C { static GET() { const u = ownerCaller(); return Response.json(u); } }
       export const GET = C.GET;`,
      /ownerCaller\(\) outside an exported handler/,
    ],
    reexportStar: [`export * from '../../notes/route';`, /takes all of \.\.\/\.\.\/notes\/route/],
    namespaceRouteImport: [
      `import * as notes from '../../notes/route';
       export async function GET(req: Request) { return notes.GET(req); }`,
      /takes all of \.\.\/\.\.\/notes\/route/,
    ],
    wrappedPassedOn: [
      `import { GET as notes } from '../../notes/route';
       const withX = (h: any) => h;
       export const GET = withX(notes);`,
      /passes notes .* other than calling it/,
    ],
    wrappedInHelper: [
      `import { GET as notes } from '../../notes/route';
       function run(r: Request) { return notes(r); }
       export async function GET(req: Request) { return run(req); }`,
      /notes\(\) outside an exported handler/,
    ],
  };
  for (const [name, [src, error]] of Object.entries(refused)) {
    it(`refuses at generation: ${name}`, () => {
      expect(() => reads(src)).toThrow(error);
    });
  }

  it('a helper of lib that reads it is not taken as read here (ESLint refuses its import)', () => {
    // The route runs whoAmI(); its row has no caller, so a read inside it
    // would throw (fail closed). owner-caller-imports.mjs refuses the
    // import of ownerCaller outside an app/api route file.
    const src = `import { whoAmI } from '@/lib/who';
      export async function GET() { return Response.json(whoAmI()); }`;
    expect(reads(src)).toEqual([]);
  });

  it('takes a plain read and a plain wrapper of each shape', () => {
    expect(
      reads(`${IMPORT}
        export async function GET() { ownerCaller(); return new Response(null); }
        export async function POST() { const { id } = ownerCaller(); return Response.json(id); }
        export const PUT = async () => ownerCaller();`),
    ).toEqual(['GET', 'POST', 'PUT']);
    expect(
      reads(`import { GET as notes } from '../../notes/route';
        export async function GET(req: Request, ctx: { params: unknown }) { return await notes(req, ctx); }
        export const POST = (req: Request) => notes(req);
        export { notes as PATCH };`),
    ).toEqual(['GET', 'PATCH', 'POST']);
  });
});
