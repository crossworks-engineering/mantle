import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CALLER_READERS, READER_ANSWERS, SESSION_GUARDS } from './session-guards.mjs';

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

  it("names each reader's guard, its caller kind and a sweep entry of its own", () => {
    const entries = new Set<string>();
    for (const [reader, { caller, guard, entry }] of Object.entries(READER_ANSWERS)) {
      expect(SESSION_GUARDS, reader).toContain(guard);
      expect(['owner', 'member', 'login', 'chat', 'session'], reader).toContain(caller);
      expect(entry, reader).toMatch(new RegExp(`^pipeline:${caller}[A-Za-z]*$`));
      entries.add(entry);
    }
    expect(entries.size).toBe(CALLER_READERS.length);
    // The readers of A4 step 3b part 5, one per guard they replaced.
    expect(READER_ANSWERS.memberCaller?.guard).toBe('getMemberOr401');
    expect(READER_ANSWERS.loginCaller?.guard).toBe('getLoginOr401');
    expect(READER_ANSWERS.chatLoginCaller?.guard).toBe('getChatLoginOr401');
    expect(READER_ANSWERS.sessionUserCaller?.guard).toBe('getSessionUser');
  });
});
