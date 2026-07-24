/**
 * Local stand-in for `next/server`'s NextResponse, covering exactly the API
 * surface this app uses (verified by inventory):
 *
 *   NextResponse.json(data, init?)         — 1000+ call sites
 *   new NextResponse(body, init?)          — byte/stream bodies, 404 text
 *   NextResponse.redirect(url, init?)      — OAuth + SSO redirects
 *   res.cookies.set(name, value, opts)     — 7 setters
 *   res.cookies.delete(name)               — MS OAuth callback
 *
 * It EXTENDS Response, so the auth-return contract
 * (`getOwnerOr401(): SessionUser | NextResponse`) and every
 * `instanceof NextResponse` / `instanceof Response` guard keep working, and
 * Hono passes instances straight through to the wire.
 *
 * NOT implemented (unused in this app): NextResponse.next()/rewrite(),
 * request-cookie access on the response, `nextUrl`.
 */

export type CookieSetOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  maxAge?: number;
  expires?: Date;
  domain?: string;
};

const SAME_SITE_LABEL = { lax: 'Lax', strict: 'Strict', none: 'None' } as const;

export function serializeCookie(name: string, value: string, opts: CookieSetOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${SAME_SITE_LABEL[opts.sameSite]}`);
  return parts.join('; ');
}

/** Mutation view over a response's Set-Cookie headers (NextResponse.cookies). */
export class ResponseCookies {
  constructor(private readonly headers: Headers) {}

  set(name: string, value: string, opts?: CookieSetOptions): this {
    this.headers.append('Set-Cookie', serializeCookie(name, value, opts));
    return this;
  }

  /** Expire a cookie immediately (Next semantics: empty value, Max-Age=0, path /). */
  delete(name: string): this {
    this.headers.append('Set-Cookie', serializeCookie(name, '', { path: '/', maxAge: 0 }));
    return this;
  }
}

export class NextResponse extends Response {
  readonly cookies: ResponseCookies;

  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    this.cookies = new ResponseCookies(this.headers);
  }

  static override json(data: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify(data), { ...init, headers });
  }

  static override redirect(url: string | URL, init?: number | ResponseInit): NextResponse {
    const status = typeof init === 'number' ? init : (init?.status ?? 307);
    const headers = new Headers(typeof init === 'number' ? undefined : init?.headers);
    headers.set('Location', String(url));
    return new NextResponse(null, { status, headers });
  }
}
