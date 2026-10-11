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

  it('every entry names its phase and a reason', () => {
    for (const [f, e] of Object.entries(ALLOW)) {
      expect(['W5b2', 'W5c', 'W6b', 'W7', 'W8', 'keep'], f).toContain(e.phase);
      expect(e.why.length, f).toBeGreaterThan(5);
      expect(e.lines, f).toBeGreaterThan(0);
    }
  });

  it('currentViewerLevel has no product caller left (plan S2)', () => {
    const callers = Object.keys(ALLOW).filter((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8');
      return /currentViewerLevel\s*\(/.test(
        text.replace(/export function currentViewerLevel\(/, ''),
      );
    });
    expect(callers).toEqual([]);
  });

  it('sweeps product code only', () => {
    expect(repoPath('/home/u/mantle/packages/content/src/x.ts')).toBe('packages/content/src/x.ts');
    expect(isSwept('packages/content/src/x.ts')).toBe(true);
    expect(isSwept('server/web/components/share/a.tsx')).toBe(true);
    expect(isSwept('scripts/counts.sql')).toBe(true);
    expect(isSwept('packages/content/src/x.test.ts')).toBe(false);
    expect(isSwept('packages/db/migrations/0256_x.sql')).toBe(false);
    expect(isSwept('packages/content/src/archive/old.ts')).toBe(false);
    expect(isSwept('packages/content/README.md')).toBe(false);
  });

  const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
  it('flags a level read outside the allowlist, and nothing inside it', () => {
    tester.run('level-reads', rule, {
      valid: [
        { code: 'const x = currentScope();', filename: '/r/packages/search/src/index.ts' },
        { code: 'const a = n.audience;', filename: '/r/packages/db/src/client.ts' },
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
