// The mechanical half of the documentation-style checklist, for every page
// the site publishes: word ceiling, no em or en dashes and no "--" in prose,
// no listed AI-tell words, and a title. The other half (answer first, cut
// what the reader can skip, facts checked in code) needs a human.
//
//   node scripts/check-pages.mjs        exit 1 on any problem
import fs from 'node:fs';
import path from 'node:path';
import { GUIDE_ROOT, SECTIONS } from '../src/lib/guide.mjs';

const MAX_WORDS = 600;
const TELLS = [
  "it's worth noting", 'importantly', 'in essence', 'simply put', "let's dive", 'dive in',
  'powerful', 'seamless', 'robust', 'effortless', 'cutting-edge', 'unlock', 'leverage',
  'elevate', 'supercharge', 'in summary', "that's it", 'happy building',
];

function files() {
  const out = ['00-index.md'];
  for (const { dir } of SECTIONS) {
    const abs = path.join(GUIDE_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (f.endsWith('.md')) out.push(`${dir}/${f}`);
  }
  return out.filter((rel) => fs.existsSync(path.join(GUIDE_ROOT, rel)));
}

/** Prose only: drop frontmatter, fenced code and inline code. */
function prose(raw) {
  return raw
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

const problems = [];
for (const rel of files()) {
  const raw = fs.readFileSync(path.join(GUIDE_ROOT, rel), 'utf8');
  const text = prose(raw);
  const words = text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  if (words > MAX_WORDS) problems.push(`${rel}: ${words} words (ceiling ${MAX_WORDS})`);
  text.split('\n').forEach((line, i) => {
    if (/[—–]/.test(line)) problems.push(`${rel}:${i + 1}: em or en dash`);
    if (/(^|\s)--(\s|$)/.test(line)) problems.push(`${rel}:${i + 1}: "--" used as a dash`);
    if (/!(\s|$)/.test(line.replace(/!\[/g, ''))) problems.push(`${rel}:${i + 1}: exclamation mark`);
    const lower = line.toLowerCase();
    for (const t of TELLS) {
      // "Unlock" is the literal word for opening a protected PDF.
      if (t === 'unlock' && (/pdf|password/.test(lower) || rel.includes('pdf'))) continue;
      if (new RegExp(`\\b${t.replace(/[-']/g, '.')}\\b`).test(lower)) {
        problems.push(`${rel}:${i + 1}: AI tell "${t}"`);
      }
    }
  });
  const isHelp = rel.startsWith('06-help/');
  if (!isHelp && !/^# \S/.test(raw)) problems.push(`${rel}: first line must be the "# Title"`);
  if (isHelp && !/^---\ntitle: \S/.test(raw)) problems.push(`${rel}: help page needs a title in frontmatter`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`check-pages: ${files().length} pages pass.`);
