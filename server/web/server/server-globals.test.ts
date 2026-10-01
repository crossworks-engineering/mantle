/**
 * The server must not let @hono/node-server replace `global.Response`.
 *
 * With the default (overrideGlobalObjects on), serve() swaps the global after
 * every module has loaded. NextResponse (server/http-compat) extends the
 * ORIGINAL Response, so a route's `if (user instanceof Response) return user`
 * is false for the 401/403 that getOwnerOr401 returns, and the handler runs on
 * with the refusal object as its user. A member login reached admin handlers
 * that way on dev (2026-09-26); only handlers that query by `user.id` crashed.
 *
 * The tests below build the app in-process (no serve()), so they cannot see
 * the swap. This test pins the boot option, and shows why it matters.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextResponse } from './http-compat';

describe('server globals', () => {
  it('main.ts starts the server with overrideGlobalObjects: false', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(main).toMatch(/serve\(\s*\{[^}]*overrideGlobalObjects:\s*false[^}]*\}/);
  });

  it('a swapped global Response breaks the route guard (why the option matters)', () => {
    const refusal = NextResponse.json({ error: 'forbidden' }, { status: 403 });
    expect(refusal instanceof Response).toBe(true);
    // What node-server's override installs: a subclass-like stand-in whose
    // prototype chain sits ABOVE the original, not below it.
    const Original = globalThis.Response;
    class Swapped {}
    Object.setPrototypeOf(Swapped.prototype, Original.prototype);
    expect(refusal instanceof (Swapped as unknown as typeof Response)).toBe(false);
  });
});
