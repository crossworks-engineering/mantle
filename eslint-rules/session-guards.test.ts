import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CALLER_READERS,
  READER_ANSWERS,
  RETIRED_GUARDS,
  SESSION_GUARDS,
} from './session-guards.mjs';

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
      // The guard it replaced: one session.ts has, or one it no longer has
      // whose name the sweep's recorded files spell (RETIRED_GUARDS). The
      // frame ticket replaced none.
      if (guard !== null) expect([...SESSION_GUARDS, ...RETIRED_GUARDS], reader).toContain(guard);
      else expect(reader).toBe('frameTicketCaller');
      expect(entry, reader).toMatch(new RegExp(`^pipeline:${caller}[A-Za-z]*$`));
      entries.add(entry);
    }
    expect(entries.size).toBe(CALLER_READERS.length);
    // S8d: the legacy readers are gone; each Login reader is the one reader
    // of its guard's answer and keeps the legacy reader's entry.
    for (const gone of [
      'loginCaller',
      'chatLoginCaller',
      'publicLoginCaller',
      'ownerCallerWithLogin',
    ]) {
      expect(READER_ANSWERS, gone).not.toHaveProperty(gone);
    }
    expect(READER_ANSWERS.anyLoginCaller?.entry).toBe('pipeline:login');
    expect(READER_ANSWERS.chatCaller?.entry).toBe('pipeline:chat');
    expect(READER_ANSWERS.publicLoginItself?.entry).toBe('pipeline:publicLogin');
    expect(READER_ANSWERS.ownerLoginCaller?.entry).toBe('pipeline:ownerWithLogin');
    // A retired guard is gone from session.ts.
    for (const g of RETIRED_GUARDS) expect(exported, g).not.toContain(g);
    // The readers of A4 step 3b part 5, one per guard they replaced.
    expect(READER_ANSWERS.memberCaller?.guard).toBe('getMemberOr401');
    expect(READER_ANSWERS.anyLoginCaller?.guard).toBe('getLoginOr401');
    expect(READER_ANSWERS.chatCaller?.guard).toBe('getChatLoginOr401');
    expect(READER_ANSWERS.sessionUserCaller?.guard).toBe('getSessionUser');
    // A4 hand batch B: the asset guards, the frame ticket, and the answers
    // taken at the read.
    expect(READER_ANSWERS.ownerAssetCaller?.guard).toBe('getOwnerForAsset');
    expect(READER_ANSWERS.readerAssetCaller?.guard).toBe('getReaderForAsset');
    expect(READER_ANSWERS.publicLoginItself).toMatchObject({
      guard: 'getLoginOr401',
      atRead: true,
    });
    expect(READER_ANSWERS.cookieUpgradeCaller).toMatchObject({
      guard: 'getCookieUpgradeLoginOr401',
      atRead: true,
    });
    expect(READER_ANSWERS.ownerCallerAtRead).toMatchObject({
      guard: 'getOwnerOr401',
      atRead: true,
    });
  });

  it("the kinds answered at the read are the policy table's (route-policy.ts ANSWERED_AT_READ)", () => {
    const policy = readFileSync(join(ROOT, 'server/web/lib/auth/route-policy.ts'), 'utf8');
    const block = /export const ANSWERED_AT_READ[^\n]*\n([\s\S]*?)\]\);/.exec(policy)?.[1] ?? '';
    const listed = [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
    const atRead = Object.values(READER_ANSWERS)
      .filter((r) => r.atRead === true)
      .map((r) => r.caller);
    expect(listed.sort()).toEqual([...new Set(atRead)].sort());
  });
});
