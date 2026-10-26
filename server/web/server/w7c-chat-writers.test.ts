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
 *
 * recordTurn's own row is insertConversationRow's (@mantle/db
 * conversation-writes.ts), which names the bound login itself when a login
 * actor is bound; its call and its insert are swept too.
 *
 * W7 integration fix 2: so does each direct `insert(assistantMessages)` and
 * `insert(chatThreads)`, and a call that passes a variable instead of an
 * inline object is checked through that variable's object in the same file
 * (one the sweep cannot resolve fails, rather than passing unseen).
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
  // The one-off copy of the owner bot's Telegram history into the owner's
  // thread (the database names the anchor): Telegram's, W7d.
  'server/web/scripts/backfill-conversation.ts',
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
  const re = new RegExp(`\\b${fn}\\(\\s*\\{`, 'g');
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

/** The object a variable named `name` is set to in `src`, or null. */
function objectOf(src: string, name: string): string | null {
  const m = new RegExp(`\\b(?:const|let)\\s+${name}\\b[^=;]*=\\s*\\{`).exec(src);
  if (!m) return null;
  return balanced(src, m.index + m[0].length - 1);
}

/** The balanced `{...}` (or `(...)`) starting at `start`. */
function balanced(src: string, start: number): string {
  const open = src[start]!;
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  let i = start;
  for (; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

/** The argument of each `fn(name)` call that passes a variable: its object
 *  when the file sets it, else a marker the check refuses. */
function variableCalls(src: string, fn: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${fn}\\((\\w+)\\)`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out.push(objectOf(src, m[1]!) ?? `<unresolved ${m[1]}>`);
  }
  return out;
}

/** The `.values(...)` argument of each insert into `table`: an inline
 *  object, or the object a variable passed there is set to. */
function inserts(src: string, table: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\.insert\\(${table}\\)\\s*\\.values\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const arg = balanced(src, m.index + m[0].length - 1)
      .slice(1, -1)
      .trim();
    if (arg.startsWith('{')) out.push(arg);
    else {
      const name = /^\w+/.exec(arg)?.[0];
      out.push((name && objectOf(src, name)) ?? `<unresolved ${arg.slice(0, 40)}>`);
    }
  }
  return out;
}

describe('W7c: every chat row writer names its login', () => {
  const files = SCAN.flatMap((d) => sources(join(ROOT, d)));
  const writers = files
    .map((f) => {
      const src = readFileSync(f, 'utf8');
      return {
        file: relative(ROOT, f),
        calls: [
          ...calls(src, 'recordTurn'),
          ...calls(src, 'appendThreadMessage'),
          ...calls(src, 'insertConversationRow'),
          ...variableCalls(src, 'recordTurn'),
          ...variableCalls(src, 'appendThreadMessage'),
          ...inserts(src, 'assistantMessages'),
          ...inserts(src, 'chatThreads'),
        ],
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
        // The direct inserts (W7 integration fix 2).
        'packages/runtime/src/agent/chat-archive.ts',
        'packages/runtime/src/agent/conversation.ts',
        // recordTurn's insert, on the system pool (S4a list).
        'packages/db/src/conversation-writes.ts',
        'packages/content/src/team-messages.ts',
      ]),
    );
  });

  it('a variable passed to a writer is read through its object (W7 integration fix 2)', () => {
    const src = `const a = { ownerId, loginId: L };\nawait recordTurn(a);\nawait recordTurn(b);\n
      await db.insert(chatThreads).values(row);\nconst row = { ownerId };`;
    expect(variableCalls(src, 'recordTurn')).toEqual(['{ ownerId, loginId: L }', '<unresolved b>']);
    expect(inserts(src, 'chatThreads')).toEqual(['{ ownerId }']);
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
