/**
 * Audit F31: member writes (autosave, Save version, create, delete, share,
 * submit, recall, comments, uploads) are rate limited per login. The gate
 * itself, and a scan that every write handler under /api/member/space*,
 * /api/member/space-files and /api/member/team-drafts calls it before doing
 * anything else, so a new write route cannot ship without it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemberCaller } from '@/lib/auth';
import { MEMBER_WRITES_PER_MIN, memberWriteGate } from './member-space';

describe('memberWriteGate', () => {
  const member = (loginId: string) => ({ loginId }) as unknown as MemberCaller;

  it('answers 429 with Retry-After once a login spends its write budget', async () => {
    const m = member('login-writes');
    for (let i = 0; i < MEMBER_WRITES_PER_MIN; i++) expect(memberWriteGate(m)).toBeNull();
    const res = memberWriteGate(m);
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBeTruthy();
    expect(((await res!.json()) as { reason: string }).reason).toBe('rate-limit');
    // Another login is untouched.
    expect(memberWriteGate(member('login-other'))).toBeNull();
  });
});

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

describe('every member write route is rate limited', () => {
  const api = join(__dirname, '..', 'app', 'api', 'member');
  const files = ['space', 'space-files', 'team-drafts'].flatMap((d) => routes(join(api, d)));

  it('finds the write routes (the scan is not vacuous)', () => {
    expect(files.some((f) => f.endsWith(join('space', '[id]', 'draft', 'route.ts')))).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it('calls memberWriteGate first in every POST, PUT, PATCH and DELETE', () => {
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const handlers = src.split(/(?=export async function )/).slice(1);
      for (const h of handlers) {
        const verb = /^export async function (\w+)/.exec(h)?.[1];
        if (!verb || verb === 'GET') continue;
        // The gate comes right after the login check, before any body or id.
        const gated =
          /if \(member instanceof Response\) return member;\n\s*const limited = memberWriteGate\(member\);\n\s*if \(limited\) return limited;/.test(
            h,
          );
        if (!gated) missing.push(`${verb} ${file.slice(api.length)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
