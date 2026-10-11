/**
 * W7c fix round 1, L7: every writer of a chat row names the login whose
 * thread it writes, explicitly. A row that names none is stamped with the
 * anchor by the database (0269), which is the owner's thread: right for the
 * owner's own work, wrong for anyone else's, and invisible in the code. So
 * the code says it.
 *
 * A source sweep, no database: each call of recordTurn or
 * appendThreadMessage outside the tests carries a `loginId` that is not a
 * bare `null`. Telegram's writers are W7d's (they name the anchor for the
 * owner's bot until Telegram is per user) and are listed, not checked.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN = ['packages', 'server'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);
/** W7d owns these (Telegram per user). */
const TELEGRAM = new Set([
  'server/api/src/agent/telegram/persist.ts',
  'server/api/src/agent/telegram/turn.ts',
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** The argument object of each `fn({ ... })` call in `src`. */
function calls(src: string, fn: string): string[] {
  const found: string[] = [];
  const re = new RegExp(`\\b${fn}\\(\\{`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(src.slice(start, i + 1));
  }
  return found;
}

describe('W7c: every chat row writer names its login', () => {
  const files = SCAN.flatMap((d) => sources(join(ROOT, d)));
  const writers = files
    .map((f) => {
      const src = readFileSync(f, 'utf8');
      return {
        file: relative(ROOT, f),
        calls: [...calls(src, 'recordTurn'), ...calls(src, 'appendThreadMessage')],
      };
    })
    .filter((w) => w.calls.length > 0);

  it('finds the writers (the sweep is not empty)', () => {
    const names = writers.map((w) => w.file);
    expect(names).toEqual(
      expect.arrayContaining([
        'server/web/workers/events-reminders.ts',
        'server/api/src/workflows/runs-resume-turn.ts',
        'packages/runtime/src/assistant/record-mcp-turn.ts',
        'packages/runtime/src/assistant/run-turn.ts',
        'packages/runtime/src/assistant/run-team-turn.ts',
      ]),
    );
  });

  it('each non-Telegram call carries a loginId that is not a bare null', () => {
    const bad: string[] = [];
    for (const w of writers) {
      if (TELEGRAM.has(w.file)) continue;
      w.calls.forEach((c, i) => {
        if (!/\bloginId\b/.test(c) || /\bloginId:\s*null\b/.test(c)) bad.push(`${w.file}#${i}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('a mobile reminder lands in the owner’s own thread, named', () => {
    const src = readFileSync(join(ROOT, 'server/web/workers/events-reminders.ts'), 'utf8');
    const [call] = calls(src, 'recordTurn');
    expect(call).toMatch(/\bloginId:\s*ownerId\b/);
  });
});
