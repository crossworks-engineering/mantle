import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * every hit as file:line. A line that runs on a box from a Mac script (inside
 * an ssh string, say) can carry the waiver `# portability: box-side`.
 *
 * A static scan cannot see everything, so this also runs the worktree harness
 * under /bin/bash (3.2 on a Mac). That harness runs git, and pre-push runs this
 * file with GIT_DIR pointing at the real repo: the harness drops every GIT_*
 * variable itself (and refuses to run if one is left), the spawn here drops
 * them too, and the sentinel cases prove a GIT_DIR left set (alone, as a hook
 * sets it, or with GIT_WORK_TREE and GIT_INDEX_FILE) cannot reach its repo.
 */
const ROOT = join(__dirname, '..', '..', '..');

/** process.env without GIT_*: a git hook exports them for the real repo. */
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/** /bin/bash (3.2 on a Mac, the oldest bash these scripts meet), else bash on PATH. */
function findBash(): string | null {
  for (const b of ['/bin/bash', 'bash']) {
    if (b.startsWith('/') && !existsSync(b)) continue;
    try {
      execFileSync(b, ['-c', 'true'], { stdio: 'ignore' });
      return b;
    } catch {
      // not runnable here: try the next one
    }
  }
  return null;
}
const BASH = findBash();
const itBash = BASH ? it : it.skip;
if (!BASH) console.warn('shell-portability: no bash found, the harness cases are skipped');

// demo/ lives only on the demo branch, never on main; its scripts are not ours.
const scripts = execFileSync('git', ['ls-files', '--', '*.sh', 'scripts/git-hooks/*', ':!demo/'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: cleanEnv(),
})
  .split('\n')
  .filter(Boolean);

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
/** A parameter: a name, a positional ($1) or a special ($@, $*). */
const PARAM = `(?:${NAME}|[0-9]+|[@*])`;

/** Bash 4+ syntax. Bash 3.2 rejects each of these, or reads it differently. */
const BASH4: [string, RegExp][] = [
  [
    'case change ${v,,} / ${v^^} (use tr)',
    new RegExp(`\\$\\{${PARAM}(\\[[^\\]]*\\])?(\\^\\^?|,,?)[^}]*\\}`),
  ],
  [
    'declare/local/typeset -A, -n, -l, -u or -g',
    /\b(declare|local|typeset)\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[Anlug]/,
  ],
  ['mapfile / readarray (use a while read loop)', /\b(mapfile|readarray)\b/],
  ['|& (use 2>&1 |)', /\|&/],
  ['&>> (use >>file 2>&1)', /&>>/],
  [
    'a bash 4 shopt option (globstar, lastpipe, inherit_errexit ...)',
    /\b(globstar|lastpipe|inherit_errexit|autocd|checkjobs|direxpand|globasciiranges)\b/,
  ],
  ['coproc', /\bcoproc\b/],
  ['negative array index ${a[-1]}', new RegExp(`\\$\\{${NAME}\\[-[0-9]+\\]\\}`)],
  [
    '${v@Q} and the other @ operators',
    new RegExp(`\\$\\{${PARAM}(\\[[^\\]]*\\])?@[QEPAKaUuLk]\\}`),
  ],
  ['wait -n', /\bwait\s+-n\b/],
  ['printf -v into an array element', new RegExp(`\\bprintf\\s+-v\\s+${NAME}\\[`)],
  ["printf '%(...)T' time format", /%\([^)]*\)T/],
  ['read -i', /\bread\b[^;|&#<(]*\s-[a-zA-Z]*i\b/],
  ['read -t with a fraction', /\bread\b[^;|&#<(]*\s-[a-zA-Z]*t\s*[0-9]*\.[0-9]/],
  ['EPOCHSECONDS / EPOCHREALTIME', /\bEPOCH(SECONDS|REALTIME)\b/],
  ['BASHPID', /\bBASHPID\b/],
  ['[[ -v ]] / test -v', /(\[\[\s+|\btest\s+)-v\s/],
  ['case fall-through ;& / ;;&', /;;&|(^|[^;]);&(\s|$)/],
  ['negative substring length ${v:0:-1}', new RegExp(`\\$\\{${NAME}:[0-9A-Za-z_ ]*:-[0-9]`)],
  ['brace range with a step {1..9..2}', /\{-?\w+\.\.-?\w+\.\.-?[0-9]+\}/],
  ['automatic fd {fd}> / {fd}<', /(?<!\$)\{[A-Za-z_]\w*\}[<>]/],
  ["$'\\u...' unicode escape", /\$'(?:[^'\\]|\\.)*\\[uU][0-9a-fA-F]/],
];

/** GNU-only tools and flags, absent or different on macOS. */
const GNU: [string, RegExp][] = [
  ['timeout (not on macOS)', /(?<![-\w])timeout\s+[-0-9"'$]/],
  [
    'sed -i without a suffix (use sed -i.bak, then rm the .bak)',
    /\bsed\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*i(\s|$)/,
  ],
  ['grep -P', /\bgrep\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*P/],
  ['date -d / --date', /\bdate\s+(-[a-zA-Z]+\s+)*(-d\b|--date)/],
  ['readlink -f', /\breadlink\s+-[a-zA-Z]*f/],
  ['xargs -r', /\bxargs\s+(-[a-zA-Z0-9]+\s+)*-[a-zA-Z0-9]*r/],
];

/**
 * `# portability: box-side` waives the GNU-tool checks on a line that runs a
 * command on a box (an ssh or docker exec on the same line): the tool runs
 * there, not on the Mac. The bash 4 and empty-array checks still apply: the
 * line itself is parsed by the Mac's bash.
 */
const WAIVER = /#\s*portability:\s*box-side\b/;
const BOX_MARKER = /\bssh\b|\bdocker\s+(compose\s+)?exec\b/;

const runsOn = (src: string) =>
  /^# runs-on: (mac|both|box)\./m.exec(src.split('\n', 4).join('\n'))?.[1];
const hasGuard = (src: string) => /BASH_VERSINFO\[0\]/.test(src.split('\n', 30).join('\n'));

type Frame = { kind: 'single' | 'ansi' | 'double' | 'subst'; parens: number };

/**
 * Every line with its comment cut off, for the scan. A small tokenizer, not a
 * shell parser: it tracks '...', $'...', "..." and $( ) (nested, across lines)
 * so a # inside any of them is kept, and a # at the top or inside $( ) after a
 * space starts a comment. Heredoc bodies are kept whole (their # is data, or a
 * comment in a script for another shell; either way it is scanned).
 * Known gaps, accepted: backticks, `case` patterns inside $( ), and a
 * heredoc whose opener sits inside a quoted string are not modelled; each
 * makes the scan see more text, never less.
 */
function scanLines(src: string): { raw: string; text: string; line: number }[] {
  const out: { raw: string; text: string; line: number }[] = [];
  const stack: Frame[] = [];
  const heredocs: { delim: string; tabs: boolean }[] = [];
  let body: { delim: string; tabs: boolean } | undefined;
  src.split('\n').forEach((raw, n) => {
    if (body) {
      out.push({ raw, text: raw, line: n + 1 });
      if ((body.tabs ? raw.replace(/^\t+/, '') : raw) === body.delim) body = heredocs.shift();
      return;
    }
    let text = raw;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      const top = stack[stack.length - 1];
      if (top?.kind === 'single') {
        if (c === "'") stack.pop();
        continue;
      }
      if (c === '\\') {
        i++;
        continue;
      }
      if (top?.kind === 'ansi') {
        if (c === "'") stack.pop();
        continue;
      }
      if (top?.kind === 'double') {
        if (c === '"') stack.pop();
        else if (c === '$' && raw[i + 1] === '(') {
          stack.push({ kind: 'subst', parens: 0 });
          i++;
        }
        continue;
      }
      // The top level, or inside $( ).
      if (c === "'") stack.push({ kind: raw[i - 1] === '$' ? 'ansi' : 'single', parens: 0 });
      else if (c === '"') stack.push({ kind: 'double', parens: 0 });
      else if (c === '$' && raw[i + 1] === '(') {
        stack.push({ kind: 'subst', parens: 0 });
        i++;
      } else if (c === '(' && top) top.parens++;
      else if (c === ')' && top) {
        if (top.parens === 0) stack.pop();
        else top.parens--;
      } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1] ?? ''))) {
        text = raw.slice(0, i);
        break;
      } else if (c === '<' && raw[i + 1] === '<' && raw[i + 2] !== '<' && raw[i - 1] !== '<') {
        const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(raw.slice(i));
        if (m?.[3]) {
          heredocs.push({ delim: m[3], tabs: m[1] === '-' });
          i += m[0].length - 1;
        }
      }
    }
    out.push({ raw, text, line: n + 1 });
    if (!body) body = heredocs.shift();
  });
  return out;
}

/** The lines to scan: comments cut, blank ones dropped, numbers kept. */
const code = (src: string) =>
  scanLines(src)
    .filter(({ text }) => text.trim() !== '')
    .map(({ raw, text, line }) => ({
      text,
      line,
      waived: WAIVER.test(raw) && BOX_MARKER.test(text),
    }));

/** Every hit of the bash 4 and GNU lists in one line of code. */
const lineHits = (text: string, list: [string, RegExp][]) =>
  list.filter(([, re]) => re.test(text)).map(([what]) => what);

/**
 * An array that can be empty, expanded bare under set -u. Bash before 4.4
 * calls "${a[@]}" of an empty array unbound and exits. The safe form is
 * ${a[@]+"${a[@]}"}. "Can be empty" here: initialised as () or ("$@").
 */
function emptyArrayHits(src: string): { line: number; what: string }[] {
  if (!/^\s*set\s+-[a-zA-Z]*u/m.test(src)) return [];
  const maybeEmpty = new Set<string>();
  for (const m of src.matchAll(new RegExp(`\\b(${NAME})=\\(\\s*("\\$@"\\s*)?\\)`, 'g'))) {
    if (m[1]) maybeEmpty.add(m[1]);
  }
  const hits: { line: number; what: string }[] = [];
  for (const { text, line } of code(src)) {
    const bare = text.replace(
      new RegExp(`\\$\\{(${NAME})\\[[@*]\\]\\+"\\$\\{\\1\\[[@*]\\]\\}"\\}`, 'g'),
      '',
    );
    for (const m of bare.matchAll(new RegExp(`\\$\\{(${NAME})\\[[@*]\\]\\}`, 'g'))) {
      if (m[1] && maybeEmpty.has(m[1])) {
        hits.push({
          line,
          what: `\${${m[1]}[@]} may be empty under set -u (use \${${m[1]}[@]+"\${${m[1]}[@]}"})`,
        });
      }
    }
  }
  return hits;
}

/** Run a harness under BASH; its output, or a thrown error with all of it. */
function runHarness(script: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(BASH ?? 'bash', [join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`harness failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`, {
      cause: err,
    });
  }
}

describe('shell scripts run on the Mac (bash 3.2, BSD tools)', () => {
  it('finds the scripts, and no demo/ ones', () => {
    expect(scripts).toContain('scripts/sanity.sh');
    expect(scripts).toContain('scripts/roll.sh');
    expect(scripts.filter((f) => f.startsWith('demo/'))).toEqual([]);
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
      for (const { text, line, waived } of code(src)) {
        const gnu = where !== 'box' && !waived;
        const found = [
          ...(bash4Ok ? [] : lineHits(text, BASH4)),
          ...(gnu ? lineHits(text, GNU) : []),
        ];
        if (gnu && /\bstat\s+-c\b/.test(text) && !/\bstat\s+-f\b/.test(text)) {
          found.push('stat -c with no BSD stat -f fallback');
        }
        for (const what of found) hits.push(`${f}:${line}: ${what}`);
      }
      if (!bash4Ok) for (const h of emptyArrayHits(src)) hits.push(`${f}:${h.line}: ${h.what}`);
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('the scanner catches what it claims to (self-check)', () => {
    const bash4 = [
      'x="${host,,}"',
      'x="${1,,}"',
      'set -- "${@^^}"',
      'mapfile -t A < f',
      'declare -A m',
      'declare -r -A m',
      'local -n ref=$1',
      'cmd |& tee log',
      'cmd &>> log',
      'echo "${a[-1]}"',
      'echo "${v@Q}"',
      'echo "${1@Q}"',
      'wait -n',
      'read -r -i def x',
      'read -r -t 0.5 x',
      'echo $EPOCHSECONDS',
      'echo $BASHPID',
      'exec {fd}> log',
      "printf '%(%F)T' -1",
      'shopt -s lastpipe',
      'shopt -s inherit_errexit',
      'shopt -s globstar',
      '  a) echo a ;&',
      '  a) echo a ;;&',
      "echo $'\\u2713'",
      '[[ -v X ]]',
    ];
    for (const b of bash4) expect(lineHits(b, BASH4), b).not.toEqual([]);
    const gnu = [
      'timeout 5 curl x',
      'timeout "$T" curl x',
      "sed -i 's/a/b/' f",
      'grep -oP x',
      'date -u -d @1',
      'readlink -f x',
      'xargs -r rm',
    ];
    for (const b of gnu) expect(lineHits(b, GNU), b).not.toEqual([]);
    const good = [
      "x=\"$(printf '%s' \"$v\" | tr '[:upper:]' '[:lower:]')\"",
      'echo "${A:-${B:-9000}}"',
      'echo "${1:-a,b}"',
      'echo ${a[@]+"${a[@]}"}',
      "sed -i.bak 's/a/b/' f",
      'pip install --timeout 10 x',
      'local -a list',
      'local -r name=x',
      'read -r line < <(cmd -i)',
      'echo "${#a[@]}" "${x#pre}" "$#"',
      'case $x in a) ;; esac 2>&1',
    ];
    for (const g of good) expect(lineHits(g, [...BASH4, ...GNU]), g).toEqual([]);

    // Comments are not code; a # inside quotes, $( ) or ${x#p} is.
    const text = (src: string) => code(src).map((l) => l.text);
    expect(text('echo hi # mapfile here\n')).toEqual(['echo hi ']);
    expect(text('echo "a # b" ${x#p} $#\n')).toEqual(['echo "a # b" ${x#p} $#']);
    expect(text('x="$(printf "%s" "a # b" | tr a b)" # ${v,,}\n')).toEqual([
      'x="$(printf "%s" "a # b" | tr a b)" ',
    ]);
    expect(text("x=$'it\\'s # not a comment'\n")).toEqual(["x=$'it\\'s # not a comment'"]);
    expect(text('x="line one\n# still in the string ${v,,}"\n')).toEqual([
      'x="line one',
      '# still in the string ${v,,}"',
    ]);
    // A heredoc body is kept whole, and the code after it is parsed again.
    expect(text("cat <<'EOF'\nsee # ${v,,}\nEOF\necho x # y\n")).toEqual([
      "cat <<'EOF'",
      'see # ${v,,}',
      'EOF',
      'echo x ',
    ]);

    // The waiver: GNU checks only, and only on a line that runs on a box.
    const [onBox] = code('ssh box "timeout 5 x; mapfile -t A < f" # portability: box-side\n');
    expect(onBox?.waived).toBe(true);
    expect(lineHits(onBox?.text ?? '', BASH4)).not.toEqual([]);
    const [local] = code('timeout 5 curl x # portability: box-side\n');
    expect(local?.waived).toBe(false);
    expect(
      emptyArrayHits('set -u\nA=()\nssh box "x ${A[@]}" # portability: box-side\n'),
    ).toHaveLength(1);

    expect(emptyArrayHits('set -u\nA=()\nfor x in "${A[@]}"; do :; done\n')).toHaveLength(1);
    expect(emptyArrayHits('set -u\nA=()\nfor x in ${A[@]+"${A[@]}"}; do :; done\n')).toHaveLength(
      0,
    );
  });

  it('every harness drops GIT_* (and refuses to run if any is left) before its first command', () => {
    for (const f of ['test-rm-worktree.sh', 'test-deploy-scripts.sh', 'test-tag-release.sh']) {
      const lines = code(readFileSync(join(ROOT, 'scripts', f), 'utf8')).map((l) => l.text);
      const drop = lines.findIndex((l) => /unset "\$gv".*\^\\\(GIT_/.test(l));
      expect(drop, `${f} does not drop GIT_*`).toBeGreaterThanOrEqual(0);
      // Only `set` may come before it.
      expect(
        lines.slice(0, drop).every((l) => /^set\s/.test(l)),
        f,
      ).toBe(true);
      expect(lines[drop + 1], `${f} does not refuse a GIT_* left set`).toMatch(
        /if env \| grep -q '\^GIT_'/,
      );
    }
  });

  itBash(
    'the worktree harness passes under /bin/bash (3.2 on a Mac)',
    () => {
      const out = runHarness('test-rm-worktree.sh', cleanEnv());
      expect(out).toMatch(/all passed/);
    },
    90_000,
  );

  // tag-release.sh against a local bare origin: verify before the tag, an
  // atomic push without the hook, and origin asked (ls-remote) afterwards.
  itBash(
    'the tag-release harness passes under /bin/bash (3.2 on a Mac)',
    () => {
      const out = runHarness('test-tag-release.sh', cleanEnv());
      expect(out).toMatch(/all passed/);
    },
    90_000,
  );

  // What a git hook exports is GIT_DIR alone; the full set is checked too.
  const sentinelEnvs: [string, (repo: string) => NodeJS.ProcessEnv][] = [
    ['GIT_DIR alone, as a git hook sets it', (repo) => ({ GIT_DIR: join(repo, '.git') })],
    [
      'GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE',
      (repo) => ({
        GIT_DIR: join(repo, '.git'),
        GIT_WORK_TREE: repo,
        GIT_INDEX_FILE: join(repo, '.git', 'index'),
      }),
    ],
  ];
  for (const [shape, gitEnv] of sentinelEnvs) {
    itBash(
      `a repo named by ${shape} is untouched by the worktree harness`,
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'shell-portability-sentinel-'));
        try {
          const repo = join(dir, 'repo');
          const git = (...args: string[]) =>
            execFileSync('git', ['-C', repo, ...args], {
              encoding: 'utf8',
              env: cleanEnv(),
            }).trim();
          execFileSync('git', ['init', '-q', repo], { env: cleanEnv() });
          writeFileSync(join(repo, 'sentinel'), 'x\n');
          git('add', 'sentinel');
          git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 's');
          const state = () => ({
            config: readFileSync(join(repo, '.git', 'config'), 'utf8'),
            refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
            head: git('rev-parse', 'HEAD'),
            commits: git('rev-list', '--all', '--count'),
            worktrees: git('worktree', 'list', '--porcelain'),
            status: git('status', '--porcelain'),
          });
          const before = state();
          let out = '';
          let failed: unknown;
          try {
            out = runHarness('test-rm-worktree.sh', { ...cleanEnv(), ...gitEnv(repo) });
          } catch (err) {
            failed = err;
          }
          // The repo first: this must fail on its own when the guard is gone,
          // not only because the harness happened to fail too.
          expect(state(), 'the harness wrote to the repo GIT_DIR names').toEqual(before);
          if (failed) throw failed;
          expect(out).toMatch(/all passed/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      90_000,
    );
  }
});
