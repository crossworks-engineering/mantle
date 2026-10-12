import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import { isSwept } from './level-reads.mjs';

/**
 * The R6 sweep (workspaces plan R6, S2, T4; phase W5b2): every caller of
 * withViewer says whom it acts for, and no product code reaches a level
 * role any other way. withViewer builds a WORKSPACE scope from that (a
 * login's workspaces, an assistant's workspace, a link's served list): the
 * old level roles serve only personal spaces (until W6b), inside
 * packages/db/src/client.ts. withHumanViewer and withTeamDrafts, the last
 * level-role path (the review flows), went in W5c: nothing may call them.
 * The runtime half (what each scope reads) is
 * packages/db/src/viewer-shim.db.test.ts.
 *
 * A guarded function is found however it is reached: by its own name, on a
 * namespace (`db.withViewer(`), through a renamed import or destructure
 * (`import { withViewer as wv }`, `const { withViewer: wv } = await
 * import(...)`), and it is never passed around as a value (`const wv =
 * withViewer`, `{ withViewer }`, `m['withViewer']`), so no call escapes the
 * checks below. The fixtures at the end pin each of those.
 */
const ROOT = join(__dirname, '..');

const CLIENT = 'packages/db/src/client.ts';
const VIEWER = 'packages/db/src/viewer.ts';
const DB_INDEX = 'packages/db/src/index.ts';

/** Where the scope functions are defined (and re-exported): exempt. */
const HOME = new Set([CLIENT, VIEWER, DB_INDEX]);

/** Entered only inside client.ts: a workspace scope is opened by
 *  withViewer for whom it acts for (or by a turn, withTurnScope), never
 *  from a hand-built scope. */
const CLIENT_ONLY = ['withScope', 'runInViewerScope'] as const;

/** The level-role entries: client.ts and viewer.ts only (tests excepted). */
const LEVEL_ENTRIES = ['runInTxScope', 'getViewerDb', 'runInLevelRoleForTest'] as const;

/**
 * The human level-role path (team drafts, client requests) went with review
 * in workspaces W5c: no caller is left, and client.ts defines neither any
 * more. A call anywhere fails here: a member reads in a workspace scope
 * (withViewer) instead.
 */
const GONE_SCOPES = ['withHumanViewer', 'withTeamDrafts'] as const;

const GUARDED = ['withViewer', ...CLIENT_ONLY, ...LEVEL_ENTRIES, ...GONE_SCOPES] as const;

function sweptFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', 'packages', 'server', 'scripts'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').filter((f: string) => isSwept(f) && /\.(ts|tsx|mjs|js)$/.test(f));
}

function load(f: string): string | null {
  try {
    return readFileSync(join(ROOT, f), 'utf8');
  } catch {
    return null; // listed by git, deleted in the working tree
  }
}

/** The file's code without comments (they may name withViewer in prose). */
function code(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The code with double-quoted strings blanked too (error messages may name
 *  withViewer). Module specifiers and keys are single-quoted here. */
function blanked(src: string): string {
  return src.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const esc = (s: string) => s.replace(/[$]/g, '\\$');

/** The keys of ViewerFor, the type of withViewer's second argument: a new
 *  variant there is a new accepted key here. */
function viewerForKeys(): string[] {
  const text = code(load(VIEWER)!);
  const at = text.indexOf('export type ViewerFor');
  expect(at, 'ViewerFor is declared in viewer.ts').toBeGreaterThan(0);
  const keys: string[] = [];
  let depth = 0;
  // The type ends at the first `;` outside braces (a variant may hold `;`).
  const start = text.indexOf('=', at) + 1;
  let end = start;
  for (let d = 0; end < text.length; end++) {
    if (text[end] === '{') d++;
    else if (text[end] === '}') d--;
    else if (text[end] === ';' && d === 0) break;
  }
  const body = text.slice(start, end);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') {
      if (depth++ === 0) {
        const key = /^\s*([\w$]+)\s*\??\s*:/.exec(body.slice(i + 1));
        if (key) keys.push(key[1]!);
      }
    } else if (c === '}') depth--;
  }
  return keys;
}

/** Every local name `src` binds to `name`: the name itself (a direct or a
 *  namespace call), a renamed import or re-export (`name as x`) and a
 *  renamed destructure (`const { name: x } = ...`). */
function localNames(src: string, name: string): string[] {
  const out = new Set([name]);
  for (const m of src.matchAll(new RegExp(`(?<![\\w$])${esc(name)}\\s+as\\s+([\\w$]+)`, 'g'))) {
    out.add(m[1]!);
  }
  for (const d of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    const re = new RegExp(`(?<![\\w$])${esc(name)}\\s*:\\s*([\\w$]+)`, 'g');
    for (const m of d[1]!.matchAll(re)) out.add(m[1]!);
  }
  return [...out];
}

/** The text of every call of `local` in `text` (direct, on a namespace,
 *  optional or generic), parentheses balanced; declarations skipped. */
function calls(text: string, local: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w$])${esc(local)}\\s*(?:\\?\\.)?\\s*(?:<[^()]*?>)?\\s*\\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/function\s*\*?\s*$/.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    out.push(`${local}(${text.slice(m.index + m[0].length, i)})`);
  }
  return out;
}

/** Spans where a bare name is a binding, not a use: import and export
 *  clauses and destructuring patterns. */
function bindingSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const res = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\}/g,
    /\b(?:const|let|var)\s*\{[^}]*\}\s*=/g,
  ];
  for (const re of res) {
    for (const m of text.matchAll(re)) spans.push([m.index!, m.index! + m[0].length]);
  }
  return spans;
}

/** Each place `local` is used as a VALUE (passed, aliased, stored, put in
 *  an object), not called: a call made through it would escape the sweep. */
function valueUses(text: string, local: string): string[] {
  const spans = bindingSpans(text);
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w$'])${esc(local)}(?![\\w$'])`, 'g');
  for (const m of text.matchAll(re)) {
    const at = m.index!;
    const after = text.slice(at + local.length);
    const before = text.slice(Math.max(0, at - 16), at);
    if (/^\s*(?:\?\.)?\s*(?:<[^()]*?>)?\s*\(/.test(after)) continue; // a call
    if (/(?:function\s*\*?|typeof)\s*$/.test(before)) continue;
    if (/^\s*as\s/.test(after) || /\bas\s+$/.test(before)) continue;
    if (spans.some(([s, e]) => at >= s && at < e)) continue;
    out.push(text.slice(Math.max(0, at - 20), at + local.length + 20).replace(/\s+/g, ' '));
  }
  // By key: m['withViewer'], m[`withViewer`].
  const byKey = new RegExp(`\\[\\s*['\`]${esc(local)}['\`]\\s*\\]`, 'g');
  for (const m of text.matchAll(byKey)) out.push(m[0]);
  return out;
}

/** What the sweep finds wrong in one file (`f`, its repo path). */
function problems(f: string, raw: string, keys: readonly string[]): string[] {
  const src = code(raw);
  const text = blanked(src);
  const bad: string[] = [];
  // The test-only level runner is never named in product code.
  if (/\brunInLevelRoleForTest\b/.test(text) && !HOME.has(f) && !f.endsWith('test-support.ts')) {
    bad.push(`${f}: runInLevelRoleForTest`);
  }
  if (HOME.has(f)) return bad;
  // An object literal naming a ViewerFor key, or the `actsFor` an app
  // tool scope built for its runner (appToolScope, H1).
  // The first argument since W8c (the level argument before it is gone).
  const actsFor = new RegExp(
    `^withViewer\\(\\s*(?:\\{\\s*(${keys.join('|')})\\s*:|[\\w$]+\\.actsFor\\s*,)`,
  );
  for (const name of GUARDED) {
    for (const local of localNames(src, name)) {
      for (const use of valueUses(text, local)) {
        bad.push(`${f}: ${name} used as a value (${use}); call it`);
      }
      const found = calls(text, local).map((c) => `${name}${c.slice(local.length)}`);
      if (!found.length) continue;
      if (name === 'withViewer') {
        for (const c of found) {
          if (!actsFor.test(c)) bad.push(`${f}: ${c.slice(0, 80).replace(/\s+/g, ' ')}`);
        }
      } else {
        bad.push(`${f}: ${name}`);
      }
    }
  }
  return bad;
}

describe('the withViewer shim sweep (R6)', () => {
  const keys = viewerForKeys();
  const all = sweptFiles().flatMap((f) => {
    const raw = load(f);
    return raw === null ? [] : problems(f, raw, keys);
  });

  it('withViewer takes whom it acts for: the ViewerFor keys', () => {
    expect(keys).toEqual(expect.arrayContaining(['login', 'agent', 'link']));
  });

  it('every withViewer call names whom it acts for', () => {
    expect(
      all.filter((p) => /: withViewer\(/.test(p)),
      `pass { ${keys.join(' | ')} } as the first argument`,
    ).toEqual([]);
  });

  it('no product code enters a level role, or a hand-built scope, outside client.ts', () => {
    const names = [...CLIENT_ONLY, ...LEVEL_ENTRIES];
    expect(all.filter((p) => names.some((n) => p.endsWith(`: ${n}`)))).toEqual([]);
  });

  it('withHumanViewer and withTeamDrafts are gone: no caller is left (W5c)', () => {
    expect(all.filter((p) => GONE_SCOPES.some((n) => p.endsWith(`: ${n}`)))).toEqual([]);
    // Nor are they defined or exported where the scopes live.
    for (const f of HOME) {
      const text = blanked(code(load(f)!));
      for (const name of GONE_SCOPES) {
        expect(new RegExp(`\\b${name}\\b`).test(text), `${f} names ${name}`).toBe(false);
      }
    }
  });

  it('no guarded function is passed around as a value', () => {
    expect(all.filter((p) => p.includes(' used as a value '))).toEqual([]);
  });

  it('nothing else is wrong', () => {
    expect(all).toEqual([]);
  });

  it('in client.ts only the workspace pool is opened (the level pools went in W8c)', () => {
    const text = blanked(code(load(CLIENT)!));
    const otherPools = calls(text, 'getViewerDb').filter((c) => !/getViewerDb\('user'\)/.test(c));
    expect(otherPools).toEqual([]);
    expect(calls(text, 'runInTxScope')).toEqual([]);
    expect(/\bfunction withSpace\b/.test(text)).toBe(false);
    expect(calls(text, 'withSpace')).toEqual([]);
  });

  it('in viewer.ts no scope carries a level (W8c)', () => {
    const text = blanked(code(load(VIEWER)!));
    expect(calls(text, 'store.run').filter((c) => /\blevel\s*:/.test(c))).toEqual([]);
    for (const name of LEVEL_ENTRIES) {
      if (name === 'getViewerDb') continue;
      expect(new RegExp(`export function ${name}\\b`).test(text), name).toBe(false);
    }
  });
});

describe('the sweep itself (fixtures)', () => {
  const KEYS = ['login', 'agent', 'link'];
  const F = 'packages/x/src/thing.ts';
  const run = (src: string, f = F) => problems(f, src, KEYS);

  it('passes a call that names whom it acts for, by any name', () => {
    expect(
      run(`import { withViewer, withViewer as wv } from '@mantle/db';
        import * as dbm from '@mantle/db';
        await withViewer({ login: id }, fn);
        await wv({ agent: a.id }, fn);
        await dbm.withViewer<number>({ link: { served } }, fn);
        await withViewer(scope.actsFor, fn);`),
    ).toEqual([]);
  });

  it('catches a level-only call made directly, renamed, on a namespace or destructured', () => {
    const cases = [
      `import { withViewer } from '@mantle/db'; withViewer(scope, fn);`,
      `import { withViewer as wv } from '@mantle/db'; wv(scope, fn);`,
      `import * as db from '@mantle/db'; db.withViewer(scope, fn);`,
      `const m = await import('@mantle/db'); await m.withViewer?.(scope, fn);`,
      `const { withViewer: wv } = await import('@mantle/db'); wv(scope, fn);`,
      `const { withViewer: wv } = dbmod; wv<T>(scope, fn);`,
      `import { withViewer } from '@mantle/db'; withViewer({ ws: [] }, fn);`,
      // The old level argument first: refused too (W8c).
      `import { withViewer } from '@mantle/db'; withViewer('team', { login: id }, fn);`,
    ];
    for (const src of cases) expect(run(src), src).toHaveLength(1);
  });

  it('accepts a new ViewerFor key once the type has it', () => {
    const src = `withViewer({ app: run }, fn);`;

    expect(run(src)).toHaveLength(1);
    expect(problems(F, src, [...KEYS, 'app'])).toEqual([]);
  });

  it('catches withScope and runInViewerScope outside client.ts, however named', () => {
    const cases = [
      `import { withScope } from '@mantle/db'; withScope(scope, fn);`,
      `import { withScope as ws } from '@mantle/db'; ws(scope, fn);`,
      `import * as v from '@mantle/db/viewer'; v.runInViewerScope(scope, fn);`,
      `const { runInViewerScope: enter } = await import('@mantle/db/viewer'); enter(s, fn);`,
    ];
    for (const src of cases) expect(run(src), src).toEqual([expect.stringMatching(/: \w+$/)]);
    expect(run(`withScope(scope, fn);`, CLIENT)).toEqual([]);
  });

  it('catches a guarded function passed around as a value', () => {
    const cases = [
      `import { withViewer } from '@mantle/db'; const wv = withViewer; wv(fn);`,
      `import * as db from '@mantle/db'; const wv = db.withViewer.bind(null, 'team');`,
      `import { withHumanViewer } from '@mantle/db'; run({ withHumanViewer });`,
      `import * as db from '@mantle/db'; db['withViewer']('team', fn);`,
      `import { withTeamDrafts } from '@mantle/db'; [a].map(withTeamDrafts);`,
    ];
    for (const src of cases) {
      expect(
        run(src).some((p) => p.includes(' used as a value ')),
        src,
      ).toBe(true);
    }
    // Types and re-export clauses are not uses.
    expect(
      run(`import { withViewer } from '@mantle/db';
        type W = typeof withViewer;
        export { withViewer } from '@mantle/db';`),
    ).toEqual([]);
  });

  it('catches withHumanViewer and withTeamDrafts anywhere, the old review routes too', () => {
    const human = `import { withHumanViewer as hv } from '@mantle/db'; hv('team', fn);`;
    expect(run(human)).toEqual([`${F}: withHumanViewer`]);
    const old = 'server/web/app/api/member/client-requests/route.ts';
    expect(run(human, old)).toEqual([`${old}: withHumanViewer`]);
    const drafts = `import * as db from '@mantle/db'; db.withTeamDrafts(fn);`;
    expect(run(drafts)).toEqual([`${F}: withTeamDrafts`]);
    const tree = 'packages/content/src/tree/member-tree.ts';
    expect(run(drafts, tree)).toEqual([`${tree}: withTeamDrafts`]);
  });

  it('ignores names in comments and double-quoted strings, and declarations', () => {
    expect(
      run(`// withViewer('team', fn)
        /* withHumanViewer('team', fn) */
        throw new Error("read outside withHumanViewer('team')");
        export async function withViewerish() {}`),
    ).toEqual([]);
  });
});
