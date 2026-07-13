/**
 * Serialize a JS string array for a `$n::uuid[]` / `$n::text[]` bind param.
 * Drizzle's postgres-js driver does NOT turn raw JS array params in sql``
 * templates into Postgres array literals (a single-element array arrives as a
 * bare string → `malformed array literal`), so array-valued filters pass one
 * string param in `{"a","b"}` form and cast it server-side. Elements are
 * quoted with `\` escaping, so values containing commas/quotes stay intact.
 */
export function pgArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')}}`;
}
