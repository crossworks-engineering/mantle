/**
 * Shared helpers for the handler tests. NOT a test file (no `.test.ts`), so
 * vitest does not collect it.
 *
 * Why this exists: a db mock whose `where` is `vi.fn().mockReturnThis()`
 * accepts any clause and asserts nothing, so deleting the owner-id term from a
 * handler leaves every test green. The 2026-09-03 audit-of-audit mutated six
 * such handlers and all six survived. Capture the clause instead and walk its
 * bound params.
 */

/** Bound parameter values of a drizzle SQL tree, in order. `eq(col, 'x')`
 *  contributes 'x'; `and(a, b)` nests. Owner scoping shows up here as the
 *  owner id being one of the params of the lookup. */
export function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
}

/**
 * Blank out comments and string/template literals, keeping `${...}` holes,
 * which ARE code. Everything that greps a handler for a token has to do this
 * first: `destructive-coverage.test.ts` was satisfied by a quoted slug sitting
 * in a comment, and these tool descriptions quote their own identifiers
 * constantly.
 */
export function stripNonCode(t: string): string {
  let out = '';
  let i = 0;
  while (i < t.length) {
    const c = t[i]!;
    if (c === '/' && t[i + 1] === '/') {
      const j = t.indexOf('\n', i);
      const end = j < 0 ? t.length : j;
      out += ' '.repeat(end - i);
      i = end;
    } else if (c === '/' && t[i + 1] === '*') {
      const j = t.indexOf('*/', i + 2);
      const end = j < 0 ? t.length : j + 2;
      out += t.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else if (c === '`') {
      let j = i + 1;
      out += ' ';
      while (j < t.length) {
        if (t[j] === '\\') {
          out += '  ';
          j += 2;
          continue;
        }
        if (t[j] === '`') {
          out += ' ';
          j += 1;
          break;
        }
        if (t[j] === '$' && t[j + 1] === '{') {
          let d = 1;
          let k = j + 2;
          out += '  ';
          while (k < t.length && d > 0) {
            if (t[k] === '{') d += 1;
            else if (t[k] === '}') d -= 1;
            if (d > 0) out += t[k];
            k += 1;
          }
          out += ' ';
          j = k;
          continue;
        }
        out += t[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      i = j;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < t.length) {
        if (t[j] === '\\') {
          j += 2;
          continue;
        }
        if (t[j] === c) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += t.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * The source text of the handler belonging to `slug: '<slug>'`, from the first
 * file that declares it.
 *
 * Walks from `handler:` to the end of that object property, tracking bracket
 * depth, so it works for BOTH shapes a def uses: a braced
 * `async (input, ctx) => { ... }` and a concise `(input, ctx) => helper(...)`.
 * Matching on the body brace alone silently skipped the concise ones and then
 * captured whatever object came next, which reads as a pass.
 */
export function handlerBodyFor(slug: string, sources: Iterable<string>): string | null {
  for (const src of sources) {
    const at = src.indexOf(`slug: '${slug}'`);
    if (at < 0) continue;
    const h = src.indexOf('handler:', at);
    if (h < 0) continue;
    let depth = 0;
    for (let k = h + 'handler:'.length; k < src.length; k += 1) {
      const c = src[k]!;
      if (c === '{' || c === '(' || c === '[') depth += 1;
      else if (c === '}' || c === ')' || c === ']') {
        depth -= 1;
        if (depth < 0) return src.slice(h, k); // closed the tool def itself
      } else if (c === ',' && depth === 0) return src.slice(h, k);
    }
    return src.slice(h);
  }
  return null;
}
