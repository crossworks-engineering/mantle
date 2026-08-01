/**
 * Reading credentials off a raw Request — the parsing half of lib/auth.
 *
 * Pure string work: no crypto, no DB, no request context. These used to be
 * re-implemented per gate, and the copies had drifted (one tolerated multiple
 * spaces after `Bearer`, two did not), so the surfaces disagreed about what
 * counted as presenting a credential at all.
 */

/**
 * The token from an `Authorization: Bearer …` header.
 *
 * Returns `null` when the request carries no bearer header, and `''` when the
 * header is present but empty. Callers distinguish the two deliberately:
 *
 *   - `if (!token)` — "no usable credential here", for surfaces where a bearer
 *     is the only accepted carrier (federation, the MCP resource server).
 *   - `if (token !== null)` — "a credential was PRESENTED, judge it on that",
 *     for surfaces that also accept a cookie. A caller who presents a bearer is
 *     answered on it and never falls through to a cookie, so a stale header
 *     can't silently be upgraded by a jar cookie belonging to someone else.
 *
 * Whitespace after `Bearer` is tolerated, per RFC 7235's `1*SP`.
 */
export function bearerFrom(req: Request): string | null {
  return bearerFromHeader(req.headers.get('authorization'));
}

/** `bearerFrom` for callers holding the header value rather than the Request —
 *  the ambient-context path, where auth resolves from `headers()`. */
export function bearerFromHeader(header: string | null): string | null {
  const m = /^Bearer(?:\s+(.*))?$/i.exec((header ?? '').trim());
  return m ? (m[1]?.trim() ?? '') : null;
}

/**
 * Every value of cookie `name` in a raw Cookie header. Path scoping means at
 * most one normally arrives, but parse liberally — a browser holding both a
 * host-scoped and a path-scoped copy sends both, and only one may verify.
 */
export function cookieValues(cookieHeader: string | null, name: string): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    if (v) out.push(decodeURIComponent(v));
  }
  return out;
}
