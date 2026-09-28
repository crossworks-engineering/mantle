/**
 * Remove NUL (U+0000) from every string in a parsed JSON body: values and
 * object keys, however deep (audit F14). Postgres stores neither a text value
 * nor a jsonb string with NUL in it, so a pasted NUL used to fail the write
 * with a bare 500, and a client that retries 5xx retried it for a minute.
 * Stripping is what the owner's editor effectively does (it escapes NUL in its
 * source); nothing a person meant to type is lost.
 *
 * Returns the same value when there is nothing to strip, so the common case
 * allocates nothing.
 */
export function stripNul<T>(value: T): T {
  return strip(value) as T;
}

function stripString(s: string): string {
  return s.includes('\u0000') ? s.replaceAll('\u0000', '') : s;
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') return stripString(value);
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const v = strip(value[i]);
      if (v !== value[i]) (out ??= value.slice())[i] = v;
    }
    return out ?? value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const key = stripString(k);
      const next = strip(v);
      if (key !== k || next !== v) changed = true;
      return [key, next] as const;
    });
    // fromEntries defines own properties, like JSON.parse: a `__proto__` key
    // stays data.
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

/** A request's JSON body with NUL stripped, or null when it is not JSON. */
export async function readJsonNoNul(req: Request): Promise<unknown> {
  return stripNul(await req.json().catch(() => null));
}
