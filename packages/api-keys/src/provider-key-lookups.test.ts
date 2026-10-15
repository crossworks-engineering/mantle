/**
 * Pin (task 698e6faf): a model provider's key is looked up through ONE
 * helper, resolveProviderKey (or findProviderKeyId for the id), never by a
 * hard `getApiKey(owner, service)`, which reads the 'default' label only. A
 * key added on /settings/keys keeps the label typed there, so every such
 * lookup missed it: the agent form listed no models for a new Anthropic key,
 * and a chat backup route, an embedding route, the decider and Telegram's
 * speech fallback found no key.
 *
 * Counted: `getApiKey(` calls in product files (packages/, server/; no tests)
 * that pass two arguments (the label defaults to 'default') or the literal
 * 'default' as the label. A call naming any other label is a named secret
 * (`{{secret:service/label}}`), not a provider lookup, and is not counted.
 * The files named below are the calls that remain, each with its reason; the
 * count may only go down.
 *
 * Second pin (fix round 1, L1): no product file outside this package picks a
 * key by service by hand (reads `apiKeys.service` or `apiKeys.label`). Such
 * picks had no stable order and could pin a different key than an unpinned
 * lookup; findProviderKeyId / findProviderKeyIds are the one pick order.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

const ALLOWED: Record<string, { calls: number; reason: string }> = {
  'packages/tools/src/builtins-locations.ts': {
    calls: 1,
    reason:
      "the Mapbox tool key, which its own error tells the owner to save as 'mapbox' / 'default'; not a model provider",
  },
};

/** Files outside this package that may read `apiKeys.service` / `.label`. */
const HAND_PICK_ALLOWED: Record<string, string> = {
  'server/web/lib/maintenance/models-drift.ts':
    "the nightly drift sweep: the oldest key per service across EVERY owner, not one owner's lookup",
};

/** Strip // and block comments (good enough for counting call sites). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The argument texts of each `getApiKey(` call in `code`. */
function getApiKeyCalls(code: string): string[][] {
  const out: string[][] = [];
  const re = /\bgetApiKey\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let cur = '';
    const args: string[] = [];
    for (; i < code.length && depth > 0; i += 1) {
      const c = code[i]!;
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') depth -= 1;
      if (depth === 0) break;
      if (c === ',' && depth === 1) {
        args.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push(args);
  }
  return out;
}

/** True for a call that reads the 'default' label only. */
function isDefaultOnly(args: string[]): boolean {
  // A definition (`getApiKey(userId: string, ...`) is not a call.
  if (args.some((a) => /^\w+\s*:/.test(a))) return false;
  if (args.length === 2) return true;
  return args.length === 3 && /^['"`]default['"`]$/.test(args[2]!);
}

function productFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', 'packages', 'server'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return listed
    .split('\n')
    .filter((p) => /\.(ts|tsx|mjs)$/.test(p))
    .filter((p) => !/\.test\.tsx?$/.test(p) && !p.endsWith('.d.ts'))
    .filter((p) => !p.startsWith('packages/api-keys/'));
}

describe('provider key lookups go through resolveProviderKey', () => {
  it("counts the parser's cases", () => {
    const code = stripComments(`
      await getApiKey(ownerId, 'openai');
      await getApiKey(ownerId, 'mapbox', 'default');
      await getApiKey(ownerId, ref.service, ref.label);
      // await getApiKey(ownerId, 'commented');
      export async function getApiKey(userId: string, service: string, label = 'default') {}
      await getApiKeyById(id);
    `);
    expect(getApiKeyCalls(code).map(isDefaultOnly)).toEqual([true, true, false, false]);
  });

  it("no 'default'-only getApiKey call outside the named files", () => {
    const found: Record<string, number> = {};
    for (const f of productFiles()) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('getApiKey(')) continue;
      const n = getApiKeyCalls(stripComments(text)).filter(isDefaultOnly).length;
      if (n) found[f] = n;
    }
    const outside = Object.keys(found).filter((f) => !ALLOWED[f]);
    expect(outside, 'use resolveProviderKey(owner, service, keyId?) from @mantle/api-keys').toEqual(
      [],
    );
    for (const [f, n] of Object.entries(found)) {
      expect(n, `${f}: ${ALLOWED[f]!.reason}`).toBeLessThanOrEqual(ALLOWED[f]!.calls);
    }
  });

  it('no hand pick of a key by service outside this package', () => {
    const found: string[] = [];
    for (const f of productFiles()) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      if (/\bapiKeys\.(service|label)\b/.test(stripComments(text))) found.push(f);
    }
    expect(
      found.filter((f) => !HAND_PICK_ALLOWED[f]),
      'use findProviderKeyId(owner, service) or findProviderKeyIds(owner) from @mantle/api-keys',
    ).toEqual([]);
    // An allow-list entry that no longer matches is stale: drop it.
    expect(Object.keys(HAND_PICK_ALLOWED).filter((f) => !found.includes(f))).toEqual([]);
  });
});
