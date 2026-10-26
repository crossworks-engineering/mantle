/**
 * Print every specialist's earlier shipped default prompts, as the sha256
 * hashes `retiredPromptSha256` lists (manifest.ts), read from git history,
 * and compare them with the manifest's lists.
 *
 * The sources: `AGENT_PROMPTS` in every commit of
 * `{apps,server}/web/lib/system-manifest/prompts.ts`, and `SYSTEM_PROMPT` in
 * every commit of the pre-manifest seed scripts. Each string is evaluated
 * statically (string and template literals, `+`, and top-level consts of the
 * same file), the way the compiler reads it; one it cannot evaluate is
 * reported, not guessed.
 *
 * A hash in history but not in the manifest is listed as MISSING; the owner
 * decides whether that default shipped (a same-day draft is listed too, since
 * a box may have booted it). A manifest hash git does not know is listed as
 * UNKNOWN. Needs the full history (not a shallow clone). Read-only.
 *
 *   pnpm -C server/web prompts:retired          # the report
 *   pnpm -C server/web prompts:retired --check  # exit 1 on MISSING / UNKNOWN
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { MANIFEST_AGENTS } from '../lib/system-manifest/manifest';

const PROMPT_FILES = [
  'apps/web/lib/system-manifest/prompts.ts',
  'server/web/lib/system-manifest/prompts.ts',
];
/** Pre-manifest seed scripts, the slug their SYSTEM_PROMPT seeded. */
const SEED_SCRIPTS: Record<string, string> = {
  'seed-pages-agent': 'pages',
  'seed-tables-agent': 'tables',
  'seed-remy': 'remy',
  'seed-researcher': 'researcher',
  'seed-coder-agent': 'coder',
};

const git = (...args: string[]): string =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1e9,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/** Evaluate a string expression, or undefined when it is not static. */
function evaluate(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  seen = new Set<string>(),
): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return evaluate(node.expression, consts, seen);
  }
  if (ts.isNonNullExpression(node)) return evaluate(node.expression, consts, seen);
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = evaluate(span.expression, consts, seen);
      if (v === undefined) return undefined;
      out += v + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evaluate(node.left, consts, seen);
    const r = evaluate(node.right, consts, seen);
    return l === undefined || r === undefined ? undefined : l + r;
  }
  if (ts.isIdentifier(node) && consts.has(node.text) && !seen.has(node.text)) {
    return evaluate(consts.get(node.text)!, consts, new Set([...seen, node.text]));
  }
  return undefined;
}

/** The file's top-level `const X = …` initializers. */
function topConsts(file: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const st of file.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
    }
  }
  return out;
}

type Found = { slug: string; hash: string; where: string; date: string };

function fromPromptsFile(
  src: string,
  date: string,
  where: string,
  out: Found[],
  failed: string[],
): void {
  const file = ts.createSourceFile('prompts.ts', src, ts.ScriptTarget.Latest, true);
  const consts = topConsts(file);
  let obj = consts.get('AGENT_PROMPTS');
  while (obj && (ts.isAsExpression(obj) || ts.isSatisfiesExpression(obj))) obj = obj.expression;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return;
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const slug =
      ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : p.name.getText(file);
    const text = evaluate(p.initializer, consts);
    if (text === undefined) failed.push(`${where} ${slug}`);
    else out.push({ slug, hash: sha(text), where, date });
  }
}

function fromSeedScript(
  src: string,
  slug: string,
  date: string,
  where: string,
  out: Found[],
  failed: string[],
): void {
  const file = ts.createSourceFile('seed.ts', src, ts.ScriptTarget.Latest, true);
  const consts = topConsts(file);
  const init = consts.get('SYSTEM_PROMPT');
  if (!init) return;
  const text = evaluate(init, consts);
  if (text === undefined) failed.push(`${where} ${slug}`);
  else out.push({ slug, hash: sha(text), where, date });
}

function main(): void {
  const check = process.argv.includes('--check');
  const root = git('rev-parse', '--show-toplevel').trim();
  if (git('-C', root, 'rev-parse', '--is-shallow-repository').trim() === 'true') {
    console.error('A shallow clone: fetch the full history first (git fetch --unshallow).');
    process.exit(2);
  }
  const found: Found[] = [];
  const failed: string[] = [];
  const show = (commit: string, path: string): string | null => {
    try {
      return git('-C', root, 'show', `${commit}:${path}`);
    } catch {
      return null; // the commit deleted it
    }
  };

  for (const path of PROMPT_FILES) {
    for (const c of git(
      '-C',
      root,
      'log',
      '--reverse',
      '--format=%h %ad',
      '--date=short',
      '--',
      path,
    )
      .trim()
      .split('\n')
      .filter(Boolean)) {
      const [commit, date] = c.split(' ') as [string, string];
      const src = show(commit, path);
      if (src) fromPromptsFile(src, date, `${commit} ${date}`, found, failed);
    }
  }
  for (const [name, slug] of Object.entries(SEED_SCRIPTS)) {
    for (const dir of ['apps/web/scripts', 'server/web/scripts']) {
      const path = `${dir}/${name}.ts`;
      for (const c of git(
        '-C',
        root,
        'log',
        '--reverse',
        '--format=%h %ad',
        '--date=short',
        '--',
        path,
      )
        .trim()
        .split('\n')
        .filter(Boolean)) {
        const [commit, date] = c.split(' ') as [string, string];
        const src = show(commit, path);
        if (src) fromSeedScript(src, slug, date, `${commit} ${date} ${name}`, found, failed);
      }
    }
  }

  let problems = 0;
  for (const a of MANIFEST_AGENTS.filter((x) => !x.isPersona && x.systemPrompt)) {
    const current = sha(a.systemPrompt!);
    const listed = new Set(a.retiredPromptSha256 ?? []);
    // Oldest first, one line per distinct earlier default (where it first
    // appeared; a stable sort keeps each file's commit order within a day).
    const history = new Map<string, string>();
    for (const f of [...found].sort((x, y) => x.date.localeCompare(y.date))) {
      if (f.slug === a.slug && f.hash !== current && !history.has(f.hash)) {
        history.set(f.hash, f.where);
      }
    }
    console.log(`\n${a.slug} (${history.size} earlier defaults in git, ${listed.size} listed)`);
    for (const [hash, where] of history) {
      const mark = listed.has(hash) ? 'listed ' : 'MISSING';
      if (!listed.has(hash)) problems++;
      console.log(`  ${mark} '${hash}', // ${where}`);
    }
    for (const hash of listed) {
      if (!history.has(hash)) {
        problems++;
        console.log(`  UNKNOWN '${hash}' (in the manifest, not in git history)`);
      }
    }
  }
  for (const f of failed) console.log(`\nnot evaluated (not a static string): ${f}`);
  if (check && problems > 0) process.exit(1);
}

main();
