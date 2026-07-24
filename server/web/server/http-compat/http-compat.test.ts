import { describe, expect, it } from 'vitest';
import { MANTLE_METHOD_HEADER, MANTLE_PATH_HEADER } from '../../lib/auth-constants';
import { runWithRequestContext } from '../request-context';
import { cookies, headers } from './headers';
import { NextResponse, serializeCookie } from './response';

describe('NextResponse shim', () => {
  it('json() produces a JSON Response that is instanceof both classes', async () => {
    const res = NextResponse.json({ ok: true }, { status: 201 });
    expect(res).toBeInstanceOf(Response);
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('json() respects caller headers (Cache-Control: no-store pattern)', () => {
    const res = NextResponse.json({}, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('redirect() supports default, positional and init statuses', () => {
    expect(NextResponse.redirect('https://x.test/a').status).toBe(307);
    expect(NextResponse.redirect('https://x.test/a', 303).status).toBe(303);
    expect(NextResponse.redirect('https://x.test/a', { status: 302 }).status).toBe(302);
    expect(NextResponse.redirect(new URL('https://x.test/a?b=1')).headers.get('location')).toBe(
      'https://x.test/a?b=1',
    );
  });

  it('cookies.set serializes the app attribute shape (login/team cookie)', () => {
    const res = NextResponse.json({ ok: true });
    res.cookies.set('mantle_session', 'tok.sig', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 1209600,
    });
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain('mantle_session=tok.sig');
    expect(sc).toContain('Path=/');
    expect(sc).toContain('Max-Age=1209600');
    expect(sc.toLowerCase()).toContain('httponly');
    expect(sc.toLowerCase()).toContain('secure');
    expect(sc.toLowerCase()).toContain('samesite=lax');
  });

  it('cookies.set on a redirect appends without clobbering (MS OAuth start)', () => {
    const res = NextResponse.redirect('https://x.test/cb', { status: 302 });
    res.cookies.set('ms_oauth_verifier', 'v1', { httpOnly: true, path: '/', maxAge: 600 });
    res.cookies.set('ms_oauth_state', 's1', { httpOnly: true, path: '/', maxAge: 600 });
    const sc = res.headers.getSetCookie();
    expect(sc).toHaveLength(2);
    expect(sc[0]).toContain('ms_oauth_verifier=v1');
    expect(sc[1]).toContain('ms_oauth_state=s1');
  });

  it('cookies.delete expires immediately (Next semantics)', () => {
    const res = NextResponse.json({});
    res.cookies.delete('ms_oauth_state');
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain('ms_oauth_state=;');
    expect(sc).toContain('Max-Age=0');
    expect(sc).toContain('Path=/');
  });

  it('serializeCookie percent-encodes values symmetrically with the parser', () => {
    expect(serializeCookie('a', 'x y;z')).toBe('a=x%20y%3Bz');
  });
});

describe('ambient headers()/cookies() shim', () => {
  const makeReq = () =>
    new Request('https://mantle.test/api/notes?x=1', {
      method: 'POST',
      headers: {
        cookie: 'mantle_session=abc.def; other="quoted"; dup=1; dup=2',
        'user-agent': 'vitest',
        // A client trying to spoof the audit path — must be overwritten.
        [MANTLE_PATH_HEADER]: '/evil',
      },
    });

  const inCtx = <T>(fn: () => T) =>
    runWithRequestContext({ req: makeReq(), path: '/api/notes', method: 'POST' }, fn);

  it('throws outside a request scope', async () => {
    await expect(headers()).rejects.toThrow(/outside a request scope/);
    await expect(cookies()).rejects.toThrow(/outside a request scope/);
  });

  it('headers() carries the request headers + server-derived path/method', async () => {
    const h = await inCtx(() => headers());
    expect(h.get('user-agent')).toBe('vitest');
    expect(h.get(MANTLE_PATH_HEADER)).toBe('/api/notes');
    expect(h.get(MANTLE_METHOD_HEADER)).toBe('POST');
  });

  it('cookies() parses, dedupes (first wins) and unquotes', async () => {
    const c = await inCtx(() => cookies());
    expect(c.get('mantle_session')?.value).toBe('abc.def');
    expect(c.get('other')?.value).toBe('quoted');
    expect(c.get('dup')?.value).toBe('1');
    expect(c.has('missing')).toBe(false);
    expect(c.getAll().map((x) => x.name)).toEqual(['mantle_session', 'other', 'dup']);
  });
});
