import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shell scripts must run on the Mac, whose /bin/bash is 3.2 (macOS never
 * ships bash 4) and whose tools are BSD, not GNU. On 2026-10-12 the pre-push
 * gate failed on a Mac in the deploy-scripts harness: sanity.sh lower-cased a
 * host with ${host,,} and listed containers with mapfile, both bash 4. The
 * Linux workstation (bash 5) passed the same tree, so nothing caught it.
 *
 * Every script names where it runs in a `# runs-on:` line under the shebang:
 *   mac   a dev or operator machine, the Mac included;
 *   both  a Linux box, and the Mac too (the deploy-scripts harness runs it);
 *   box   a Linux box or container only. It may use bash 4, but only behind a
 *         BASH_VERSINFO guard that exits with a clear message on bash 3.
 * This scans each script for bash 4+ syntax and GNU-only tool flags and names
 * every hit as file:line. A static scan cannot see everything, so the last
 * case also runs the small worktree harness under /bin/bash (3.2 on a Mac).
 */
const ROOT = join(__dirname, '..', '..', '..');

const scripts = execFileSync('git', ['ls-files', '*.sh', 'scripts/git-hooks/*'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const NAME = '[A-Za-z_][A-Za-z0-9_]*';

/** Bash 4+ syntax. Bash 3.2 rejects each of these, or reads it differently. */
const BASH4: [string, RegExp][] = [
  [
    'case change ${v,,} / ${v^^} (use tr)',
    new RegExp(`\\$\\{${NAME}(\\[[^\\]]*\\])?(\\^\\^?|,,?)[^}]*\\}`),
  ],
  ['declare/local/typeset -A, -n, -l, -u or -g', /\b(declare|local|typeset)\s+-[a-zA-Z]*[Anlug]/],
  ['mapfile / readarray (use a while read loop)', /\b(mapfile|readarray)\b/],
  ['|& (use 2>&1 |)', /\|&/],
  ['&>> (use >>file 2>&1)', /&>>/],
  ['shopt globstar', /\bglobstar\b/],
  ['coproc', /\bcoproc\b/],
  ['negative array index ${a[-1]}', new RegExp(`\\$\\{${NAME}\\[-[0-9]+\\]\\}`)],
  ['${v@Q} and the other @ operators', new RegExp(`\\$\\{${NAME}(\\[[^\\]]*\\])?@[QEPAKaUuLk]\\}`)],
  ['wait -n', /\bwait\s+-n\b/],
  ['printf -v into an array element', new RegExp(`\\bprintf\\s+-v\\s+${NAME}\\[`)],
  ['read -i', /\bread\b[^;|&#]*\s-[a-zA-Z]*i\b/],
  ['EPOCHSECONDS / EPOCHREALTIME', /\bEPOCH(SECONDS|REALTIME)\b/],
  ['[[ -v ]] / test -v', /(\[\[\s+|\btest\s+)-v\s/],
  ['case fall-through ;;&', /;;&/],
  ['negative substring length ${v:0:-1}', new RegExp(`\\$\\{${NAME}:[0-9A-Za-z_ ]*:-[0-9]`)],
  ['brace range with a step {1..9..2}', /\{-?\w+\.\.-?\w+\.\.-?[0-9]+\}/],
];

/** GNU-only tools and flags, absent or different on macOS. */
const GNU: [string, RegExp][] = [
  ['timeout (not on macOS)', /(?<![-\w])timeout\s+[-0-9]/],
  [
    'sed -i without a suffix (use sed -i.bak, then rm the .bak)',
    /\bsed\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*i(\s|$)/,
  ],
  ['grep -P', /\bgrep\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*P/],
  ['date -d / --date', /\bdate\s+(-[a-zA-Z]+\s+)*(-d\b|--date)/],
  ['readlink -f', /\breadlink\s+-[a-zA-Z]*f/],
  ['xargs -r', /\bxargs\s+(-[a-zA-Z0-9]+\s+)*-[a-zA-Z0-9]*r/],
];

const runsOn = (src: string) =>
  /^# runs-on: (mac|both|box)\./m.exec(src.split('\n', 4).join('\n'))?.[1];
const hasGuard = (src: string) => /BASH_VERSINFO\[0\]/.test(src.split('\n', 30).join('\n'));

/** The lines to scan: full-line comments dropped, numbers kept. */
const code = (src: string) =>
  src
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => !/^\s*#/.test(text));

/**
 * An array that can be empty, expanded bare under set -u. Bash before 4.4
 * calls "${a[@]}" of an empty array unbound and exits. The safe form is
 * ${a[@]+"${a[@]}"}. "Can be empty" here: initialised as () or ("$@").
 */
function emptyArrayHits(src: string): { line: number; what: string }[] {
  if (!/^\s*set\s+-[a-zA-Z]*u/m.test(src)) return [];
  const maybeEmpty = new Set<string>();
  for (const m of src.matchAll(new RegExp(`\\b(${NAME})=\\(\\s*("\\$@"\\s*)?\\)`, 'g'))) {
    maybeEmpty.add(m[1]);
  }
  const hits: { line: number; what: string }[] = [];
  for (const { text, line } of code(src)) {
    const bare = text.replace(
      new RegExp(`\\$\\{(${NAME})\\[[@*]\\]\\+"\\$\\{\\1\\[[@*]\\]\\}"\\}`, 'g'),
      '',
    );
    for (const m of bare.matchAll(new RegExp(`\\$\\{(${NAME})\\[[@*]\\]\\}`, 'g'))) {
      if (maybeEmpty.has(m[1])) {
        hits.push({
          line,
          what: `\${${m[1]}[@]} may be empty under set -u (use \${${m[1]}[@]+"\${${m[1]}[@]}"})`,
        });
      }
    }
  }
  return hits;
}

describe('shell scripts run on the Mac (bash 3.2, BSD tools)', () => {
  it('finds the scripts', () => {
    expect(scripts).toContain('scripts/sanity.sh');
    expect(scripts).toContain('scripts/roll.sh');
  });

  it('every script names where it runs (# runs-on: mac|both|box. under the shebang)', () => {
    const missing = scripts.filter((f) => !runsOn(readFileSync(join(ROOT, f), 'utf8')));
    expect(missing, 'add a "# runs-on: ..." line as line 2').toEqual([]);
  });

  it('no bash 4+ syntax, GNU-only flags or bare empty arrays where the Mac runs it', () => {
    const hits: string[] = [];
    for (const f of scripts) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const where = runsOn(src);
      // A box-only script may use bash 4 behind its guard; its tools are GNU.
      const bash4Ok = where === 'box' && hasGuard(src);
      for (const { text, line } of code(src)) {
        if (!bash4Ok)
          for (const [what, re] of BASH4) if (re.test(text)) hits.push(`${f}:${line}: ${what}`);
        if (where !== 'box') {
          for (const [what, re] of GNU) if (re.test(text)) hits.push(`${f}:${line}: ${what}`);
          if (/\bstat\s+-c\b/.test(text) && !/\bstat\s+-f\b/.test(text)) {
            hits.push(`${f}:${line}: stat -c with no BSD stat -f fallback`);
          }
        }
      }
      if (!bash4Ok) for (const h of emptyArrayHits(src)) hits.push(`${f}:${h.line}: ${h.what}`);
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('the scanner catches what it claims to (self-check)', () => {
    const bad = [
      'x="${host,,}"',
      'mapfile -t A < f',
      'declare -A m',
      'local -n ref=$1',
      'cmd |& tee log',
      'echo "${a[-1]}"',
      'echo "${v@Q}"',
      'wait -n',
      'read -r -i def x',
      'echo $EPOCHSECONDS',
    ];
    for (const b of bad)
      expect(
        BASH4.some(([, re]) => re.test(b)),
        b,
      ).toBe(true);
    for (const b of [
      'timeout 5 curl x',
      "sed -i 's/a/b/' f",
      'grep -oP x',
      'date -u -d @1',
      'readlink -f x',
      'xargs -r rm',
    ]) {
      expect(
        GNU.some(([, re]) => re.test(b)),
        b,
      ).toBe(true);
    }
    const good = [
      "x=\"$(printf '%s' \"$v\" | tr '[:upper:]' '[:lower:]')\"",
      'echo "${A:-${B:-9000}}"',
      'echo ${a[@]+"${a[@]}"}',
      "sed -i.bak 's/a/b/' f",
      'pip install --timeout 10 x',
      'local -a list',
    ];
    for (const g of good) {
      expect(
        [...BASH4, ...GNU].some(([, re]) => re.test(g)),
        g,
      ).toBe(false);
    }
    expect(emptyArrayHits('set -u\nA=()\nfor x in "${A[@]}"; do :; done\n')).toHaveLength(1);
    expect(emptyArrayHits('set -u\nA=()\nfor x in ${A[@]+"${A[@]}"}; do :; done\n')).toHaveLength(
      0,
    );
  });

  it('the worktree harness passes under /bin/bash (3.2 on a Mac)', () => {
    const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
    let out: string;
    try {
      out = execFileSync(bash, [join(ROOT, 'scripts', 'test-rm-worktree.sh')], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(`harness failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`, {
        cause: err,
      });
    }
    expect(out).toMatch(/all passed/);
  }, 90_000);
});
