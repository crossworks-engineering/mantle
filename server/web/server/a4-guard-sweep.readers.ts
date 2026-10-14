/**
 * Which reader of the pipeline's answer a row's handler reads (arch A4
 * step 3b), for the guard sweep (a4-guard-sweep.test.ts): its moved entry
 * is named by that reader and logs the projection it reads, so the two
 * recorded files compare it under the guard it replaced (ownerCaller():
 * getOwnerOr401; ownerCallerWithSource(): getOwnerOr401WithSource;
 * ownerCallerWithLogin(): getOwnerOr401WithLogin).
 *
 * From the route file's own code, never a list kept by hand: the one
 * reader of the one list (eslint-rules/session-guards.mjs) the file calls;
 * a file that calls none takes the method from another route file (an
 * /api/v1 alias: `export { POST } from '../../notes/route'`) and is
 * followed there. A file that calls two readers, or one that names no
 * reader and takes the method from nowhere, throws: the sweep would name
 * the entry wrong.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALLER_READERS } from '../../../eslint-rules/session-guards.mjs';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pattern to route file (absolute), from the generated manifest. */
let files: Map<string, string> | null = null;
function fileOf(pattern: string): string {
  if (!files) {
    files = new Map();
    const text = readFileSync(join(webRoot, 'server/route-manifest.gen.ts'), 'utf8');
    for (const m of text.matchAll(/pattern: "([^"]+)".*?import\("\.\.\/(.*?)"\)/g)) {
      files.set(m[1]!, routeFile(join(webRoot, m[2]!)));
    }
  }
  const file = files.get(pattern);
  if (!file) throw new Error(`a4-guard-sweep.readers: no route file for ${pattern}`);
  return file;
}

function routeFile(base: string): string {
  const file = ['.ts', '.tsx'].map((x) => base + x).find((f) => existsSync(f));
  if (!file) throw new Error(`a4-guard-sweep.readers: no file at ${base}`);
  return file;
}

/** The reader a retired route's stub reads, by its kind (lib/gone.ts
 *  `gone(kind)`, A4 hand batch A: it reads the answer of its kind). */
const GONE_READERS: Readonly<Record<string, string>> = {
  owner: 'ownerCaller',
  member: 'memberCaller',
  any: 'loginCaller',
};

function readerOf(file: string, method: string): string {
  const text = readFileSync(file, 'utf8');
  const stub = new RegExp(`export const ${method} = gone\\(\\s*'(\\w+)'`).exec(text);
  if (stub) {
    const reader = GONE_READERS[stub[1]!];
    if (!reader)
      throw new Error(`a4-guard-sweep.readers: ${file} ${method} is a gone stub of no kind`);
    return reader;
  }
  const called = CALLER_READERS.filter((r) => new RegExp(`\\b${r}\\(`).test(text));
  if (called.length === 1) return called[0]!;
  if (called.length > 1) {
    throw new Error(
      `a4-guard-sweep.readers: ${file} calls ${called.join(', ')}: name each handler's reader`,
    );
  }
  // An alias: the method re-exported or imported from another route file.
  for (const m of text.matchAll(/(?:export|import)\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const names = m[1]!.split(',').map((p) =>
      p
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim(),
    );
    if (names.includes(method) && m[2]!.startsWith('.')) {
      return readerOf(routeFile(resolve(dirname(file), m[2]!)), method);
    }
  }
  throw new Error(`a4-guard-sweep.readers: ${file} ${method} reads no reader the sweep can name`);
}

const memo = new Map<string, string>();

/** The reader the handler of the row `key` (`METHOD pattern`) reads; a
 *  HEAD row's is its GET's. */
export function readerOfRow(key: string): string {
  let reader = memo.get(key);
  if (!reader) {
    const [method, pattern] = key.split(' ') as [string, string];
    reader = readerOf(fileOf(pattern), method === 'HEAD' ? 'GET' : method);
    memo.set(key, reader);
  }
  return reader;
}
