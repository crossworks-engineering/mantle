import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import { countLevelReads, isSwept, LEVEL_READ_ALLOWLIST, repoPath, rule } from './level-reads.mjs';

/**
 * The level-reads sweep (workspaces plan S2): no product code reads the tier
 * levels outside the pinned allowlist, and the allowlist only shrinks.
 */
const ROOT = join(__dirname, '..');

type Entry = { lines: number; phase: string; why: string };
const ALLOW = LEVEL_READ_ALLOWLIST as Record<string, Entry>;

function sweptFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', 'packages', 'server', 'scripts'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').filter((f: string) => isSwept(f));
}

describe('level-reads sweep', () => {
  // The allowlist is review-only (W5b1 audit L3): a pinned count may only
  // drop. Raising one, or listing a new file, needs the CEO's review in the
  // PR; CI does not tell the two apart, the reviewer does.
  it('finds exactly the allowlisted level reads, file by file', () => {
    const found: Record<string, number> = {};
    for (const f of sweptFiles()) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue; // listed by git, deleted in the working tree
      }
      const n = countLevelReads(text);
      if (n) found[f] = n;
    }
    const unlisted = Object.keys(found).filter((f) => !Object.hasOwn(ALLOW, f));
    expect(unlisted, 'new level reads: read grants or currentScope() instead').toEqual([]);
    const changed = Object.entries(ALLOW)
      .filter(([f, e]) => (found[f] ?? 0) !== e.lines)
      .map(([f, e]) => `${f}: listed ${e.lines}, found ${found[f] ?? 0}`);
    expect(changed, 'update the pinned count (lower it when a read goes)').toEqual([]);
  });

  it('no column name is split across a string concatenation to dodge it', () => {
    // 'inherited_' + 'level' reads the column without matching the pattern:
    // join adjacent string pieces and count again (W5b1 audit L2).
    const glue = (t: string) => t.replace(/(['"`])\s*\+\s*(['"`])/g, '');
    const dodges = sweptFiles().filter((f) => {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        return false;
      }
      return countLevelReads(glue(text)) > countLevelReads(text);
    });
    expect(dodges).toEqual([]);
    expect(countLevelReads(glue("const c = 'inherited_' + 'level';"))).toBe(1);
  });

  it('holds only the files where the word means something else', () => {
    // W8c took every level read out of the code; the W8 integration kept one,
    // for a brain not on workspaces only, which arch A7 took out with that
    // brain's rules: no frozen read is left.
    const frozen: string[] = [];
    for (const [f, e] of Object.entries(ALLOW)) {
      expect(e.phase, f).toBe('keep');
      if (frozen.includes(f)) {
        expect(e.why, f).toMatch(/^frozen until W10: /);
        expect(e.lines, f).toBe(1);
      } else {
        expect(e.why, f).toMatch(/^unrelated: /);
      }
      expect(e.lines, f).toBeGreaterThan(0);
    }
    expect(Object.keys(ALLOW).filter((f) => /^frozen/.test(ALLOW[f]!.why))).toEqual(frozen);
  });

  it('no new audience read anywhere outside the archive (W8c)', () => {
    // The level columns stay in the database, frozen, until W10: a read of
    // `audience` (the word the old item, agent and tool-group levels went by)
    // in product code fails here unless its file is a pinned `keep` entry,
    // and a keep entry may not gain one. Archive folders, migrations and
    // tests are not product code (isSwept).
    const word = /\baudience\b/;
    const extra: string[] = [];
    for (const f of sweptFiles()) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      const n = text.split('\n').filter((l) => word.test(l)).length;
      if (n === 0) continue;
      const entry = ALLOW[f];
      if (!entry || n > entry.lines) extra.push(`${f}: ${n} audience line(s)`);
    }
    expect(extra, 'an audience read outside the keep list').toEqual([]);
    expect(isSwept('packages/db/src/archive/levels.ts')).toBe(false);
  });

  it('nothing defines or calls the retired level helpers (plan S2, W8c)', () => {
    const gone =
      /\b(currentViewerLevel|levelOfScope|inLevelScope|runInLevelRoleForTest|spaceLevelForLogin)\b/;
    const users = sweptFiles().filter((f) => {
      try {
        return gone.test(readFileSync(join(ROOT, f), 'utf8'));
      } catch {
        return false;
      }
    });
    expect(users).toEqual([]);
  });

  it('sweeps product code only', () => {
    expect(repoPath('/home/u/mantle/packages/content/src/x.ts')).toBe('packages/content/src/x.ts');
    expect(isSwept('packages/content/src/x.ts')).toBe(true);
    expect(isSwept('server/web/components/share/a.tsx')).toBe(true);
    expect(isSwept('scripts/counts.sql')).toBe(true);
    expect(isSwept('packages/content/src/x.test.ts')).toBe(false);
    expect(isSwept('packages/db/migrations/0256_x.sql')).toBe(false);
    expect(isSwept('packages/db/rollback/0305_x.revert.sql')).toBe(false);
    expect(isSwept('packages/content/src/archive/old.ts')).toBe(false);
    expect(isSwept('packages/content/README.md')).toBe(false);
  });

  const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
  it('flags a level read outside the allowlist, and nothing inside it', () => {
    tester.run('level-reads', rule, {
      valid: [
        { code: 'const x = currentScope();', filename: '/r/packages/search/src/index.ts' },
        { code: 'const a = c.audience;', filename: '/r/packages/tools/src/mcp-oauth.ts' },
        { code: 'const a = n.audience;', filename: '/r/packages/search/src/index.test.ts' },
      ],
      invalid: [
        {
          code: 'const a = n.audience;',
          filename: '/r/packages/search/src/index.ts',
          errors: [{ messageId: 'levelRead' }],
        },
        {
          code: "const q = sql`select 1 from nodes where inherited_level = 'team'`;",
          filename: '/r/server/web/lib/x.ts',
          errors: [{ messageId: 'levelRead' }],
        },
        {
          code: 'if (currentViewerLevel() === "admin") go();\nconst b = readAtSql(["team"]);',
          filename: '/r/packages/tools/src/y.ts',
          errors: [{ messageId: 'levelRead' }, { messageId: 'levelRead' }],
        },
      ],
    });
  });
});
