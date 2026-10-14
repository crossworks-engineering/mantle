import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CALLER_READERS, SESSION_GUARDS } from './session-guards.mjs';

/**
 * The one list of the guard names (session-guards.mjs) is session.ts's: the
 * generator, the sweep and the scoreboard read the list, so a guard added
 * to session.ts and not to the list would go unseen by all three.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const session = readFileSync(join(ROOT, 'server/web/lib/auth/session.ts'), 'utf8');
const exported = [...session.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!);

describe('session-guards', () => {
  it('lists every guard session.ts exports, and only those', () => {
    const guards = exported.filter((n) => /^(get|require)[A-Z]/.test(n));
    expect([...SESSION_GUARDS].sort()).toEqual(guards.sort());
  });

  it('lists readers session.ts exports', () => {
    for (const r of CALLER_READERS) expect(exported).toContain(r);
  });
});
