/**
 * Which reader of the pipeline's answer a row's handler reads (arch A4
 * step 3b), for the guard sweep (a4-guard-sweep.test.ts): its moved entry
 * is named by that reader and logs the projection it reads, so the two
 * recorded files compare it under the guard it replaced (ownerCaller():
 * getOwnerOr401; ownerCallerWithSource(): getOwnerOr401WithSource;
 * ownerLoginCaller(): getOwnerOr401WithLogin).
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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALLER_READERS } from '../../../eslint-rules/session-guards.mjs';
import { GONE_KINDS } from '../lib/gone-kinds';
import { goneStubs } from '../scripts/route-callers';

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

function readerOf(file: string, method: string): string {
  const text = readFileSync(file, 'utf8');
  // A retired route's stub (lib/gone.ts `gone(kind)`, A4 hand batch A): it
  // reads the answer of its kind, by the reader the one table names
  // (lib/gone-kinds.ts GONE_KINDS), as the generator reads the stub (the
  // generator's own reading of the file, so the two cannot disagree).
  const stub = goneStubs(text, relative(webRoot, file))[method];
  if (stub) return GONE_KINDS[stub].reader;
  const calls = (src: string) => CALLER_READERS.filter((r) => new RegExp(`\\b${r}\\(`).test(src));
  // The method's own handler first (a file whose handlers read two kinds:
  // GET /api/updates/check's session user beside its POST's owner, A4
  // hand batch A): from its declaration to the next export.
  const at = new RegExp(`export (?:async )?function ${method}\\b`).exec(text);
  if (at) {
    const rest = text.slice(at.index + 1);
    const end = rest.search(/\nexport /);
    const own = calls(end < 0 ? rest : rest.slice(0, end));
    if (own.length === 1) return own[0]!;
  }
  // A method with no handler of its own, re-exported from another route
  // file (an /api/v1 alias), reads what that file's handler reads, whatever
  // another handler of this file reads (the v1 page PATCH reads
  // ownerCallerAtRead() beside a re-exported GET; A8 fix round 1, L4).
  if (!at) {
    for (const m of text.matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
      if (exportNames(m[1]!).includes(method) && m[2]!.startsWith('.')) {
        return readerOf(routeFile(resolve(dirname(file), m[2]!)), method);
      }
    }
  }
  const called = calls(text);
  if (called.length === 1) return called[0]!;
  if (called.length > 1) {
    throw new Error(
      `a4-guard-sweep.readers: ${file} calls ${called.join(', ')}: name each handler's reader`,
    );
  }
  // An alias: the method re-exported or imported from another route file.
  for (const m of text.matchAll(/(?:export|import)\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    if (exportNames(m[1]!).includes(method) && m[2]!.startsWith('.')) {
      return readerOf(routeFile(resolve(dirname(file), m[2]!)), method);
    }
  }
  throw new Error(`a4-guard-sweep.readers: ${file} ${method} reads no reader the sweep can name`);
}

/** The names an `{ ... }` import or export list takes from its module. */
function exportNames(list: string): string[] {
  return list.split(',').map((p) =>
    p
      .trim()
      .split(/\s+as\s+/)[0]!
      .trim(),
  );
}

const memo = new Map<string, string>();

/** The reader the handler of the row `key` (`METHOD pattern`) reads; a
 *  HEAD row's is its GET's where the GET handler answers it (the route
 *  exports no HEAD of its own, route-policy.ts `ownHead`). */
export function readerOfRow(key: string): string {
  let reader = memo.get(key);
  if (!reader) {
    const [method, pattern] = key.split(' ') as [string, string];
    const file = fileOf(pattern);
    const ownHead =
      /export\s+(?:async\s+)?function\s+HEAD\b|export\s+const\s+HEAD\s*=|\bas\s+HEAD\b/.test(
        readFileSync(file, 'utf8'),
      );
    reader = readerOf(file, method === 'HEAD' && !ownHead ? 'GET' : method);
    memo.set(key, reader);
  }
  return reader;
}
