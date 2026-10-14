/** Which handlers read the caller the pipeline answers (arch A4 step 3b). */
import { describe, expect, it } from 'vitest';
import { handlerReads } from './route-callers';

describe('handlerReads', () => {
  it('names each exported handler that reads the owner caller', () => {
    const src = `
      import { ownerCaller, getOwnerForAsset } from '@/lib/auth';
      export async function PUT(req: Request) {
        const owner = ownerCaller();
        return Response.json(owner);
      }
      export const DELETE = async () => Response.json(ownerCaller());
      export async function GET(req: Request) {
        const user = await getOwnerForAsset(req);
        return user instanceof Response ? user : Response.json(user);
      }
    `;
    expect(handlerReads(src, 'a/route.ts')).toEqual(['DELETE', 'PUT']);
  });

  it('follows a handler exported under another name', () => {
    const src = `
      async function handle() { return Response.json(ownerCaller()); }
      export { handle as GET, handle as POST };
    `;
    expect(handlerReads(src, 'a/route.ts')).toEqual(['GET', 'POST']);
  });

  it('follows a handler another route file exports, re-exported or wrapped', () => {
    const base: Record<string, readonly string[]> = { '../../notes/route': ['GET'] };
    const follow = (spec: string) => base[spec] ?? null;
    const src = `
      import { GET as notes } from '../../notes/route';
      export { GET } from '../../notes/route';
      export { POST } from '../../notes/route';
      export async function PATCH(req: Request) { return notes(req); }
      export { DELETE } from '@/lib/elsewhere';
    `;
    expect(handlerReads(src, 'a/route.ts', follow)).toEqual(['GET', 'PATCH']);
    // Without knowing the other file, nothing it exports is taken as read.
    expect(handlerReads(src, 'a/route.ts')).toEqual([]);
  });

  it('reads none where no handler reads it', () => {
    expect(handlerReads(`export const GET = gone('owner');`, 'a/route.ts')).toEqual([]);
  });

  it('refuses a handler that reads it and calls a guard too', () => {
    const src = `
      export async function GET() {
        const a = ownerCaller();
        const b = await getOwnerOr401();
        return Response.json({ a, b });
      }
    `;
    expect(() => handlerReads(src, 'a/route.ts')).toThrow(/also calls getOwnerOr401/);
  });

  it('refuses a read outside an exported handler', () => {
    const src = `
      function who() { return ownerCaller(); }
      export async function GET() { return Response.json(who()); }
    `;
    expect(() => handlerReads(src, 'a/route.ts')).toThrow(
      /a\/route\.ts:2: ownerCaller\(\) outside/,
    );
  });
});
