// Reads the User Guide straight from the mantle repo (docs/guide) and the
// release notes (CHANGELOG.md). The site never holds its own copy: the same
// files feed the in-app /docs reader, the "?" help panel and the brain.
//
// Plain JS on purpose: astro.config.mjs builds the sidebar from it at config
// time, and the content loader renders the pages from it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const GUIDE_ROOT = path.join(REPO_ROOT, 'docs', 'guide');
export const CHANGELOG_FILE = path.join(REPO_ROOT, 'CHANGELOG.md');
const GITHUB_BLOB = 'https://github.com/crossworks-engineering/mantle/blob/main/';

/**
 * The public sections, in sidebar order. Only these folders are published:
 * anything else under docs/guide stays in the app and the brain only.
 * `06-help` (the screen help) is shown inside "Using Jackdaw".
 */
export const SECTIONS = [
  { dir: '01-install', label: 'Install' },
  { dir: '02-first-steps', label: 'First steps' },
  { dir: '03-using-jackdaw', label: 'Using Jackdaw' },
  { dir: '06-help', label: 'Screen help', parent: '03-using-jackdaw' },
  { dir: '04-concepts', label: 'Concepts' },
  { dir: '05-admin', label: 'Admin and self-hosting' },
  { dir: '07-api', label: 'API reference' },
];
const SECTION_DIRS = new Set(SECTIONS.map((s) => s.dir));
const HOME_FILE = '00-index.md';

/** `01-install/02-server.md` -> `install/server`; the home page is `index`. */
export function slugFor(rel) {
  if (rel === HOME_FILE) return 'index';
  return rel
    .replace(/\.md$/, '')
    .split('/')
    .map((seg) => seg.replace(/^\d+-/, ''))
    .join('/');
}

/** The site URL of a page id. */
export function hrefFor(id) {
  return id === 'index' ? '/' : `/${id}/`;
}

function isPublished(rel) {
  if (rel === HOME_FILE) return true;
  const [dir, file] = rel.split('/');
  return SECTION_DIRS.has(dir) && Boolean(file) && !rel.split('/').slice(2).length;
}

/** Minimal frontmatter: help files carry `title:` and `toolGroups:` only. */
function splitFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { fm: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { fm: {}, body: raw };
  const fm = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const m = /^([A-Za-z]\w*)\s*:\s*(.*)$/.exec(line.trim());
    if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: raw.slice(raw.indexOf('\n', end + 1) + 1) };
}

/**
 * Title from frontmatter, else from the page's `# H1`. The H1 is removed from
 * the body because Starlight prints the title itself; the file keeps it so
 * the in-app reader and GitHub still show a heading.
 */
function titleAndBody(raw) {
  const { fm, body } = splitFrontmatter(raw);
  let title = fm.title;
  let rest = body;
  const h1 = /^# (.+)$/m.exec(body);
  if (h1 && !body.slice(0, h1.index).trim()) {
    title ??= h1[1].trim();
    rest = body.slice(h1.index + h1[0].length);
  }
  rest = rest.replace(/^\s+/, '');
  // Screen help opens with `## <Screen>`, the same words as the title: drop it
  // so the page does not print the name twice.
  const h2 = /^## (.+)\n/.exec(rest);
  if (title && h2 && h2[1].trim().toLowerCase() === title.toLowerCase()) {
    rest = rest.slice(h2[0].length).replace(/^\s+/, '');
  }
  return { title: title ?? 'Untitled', body: rest };
}

/** First plain paragraph line: the page's one-line summary, used for meta. */
function descriptionOf(body) {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^(#|>|\||-|\*|`|\d+\.|<|!\[)/.test(t)) return undefined;
    return t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '');
  }
  return undefined;
}

/**
 * Rewrite relative `.md` links. A link to a published guide page becomes its
 * site URL; any other repo file becomes a GitHub link. `fromRepoRel` is the
 * linking file's path relative to the repo root.
 */
export function rewriteLinks(body, fromRepoRel) {
  const fromDir = path.posix.dirname(fromRepoRel);
  return body.replace(/\]\(([^()\s]+)\)/g, (whole, target) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;
    const hashAt = target.search(/[#?]/);
    const file = hashAt === -1 ? target : target.slice(0, hashAt);
    const hash = hashAt === -1 ? '' : target.slice(hashAt);
    if (!file) return whole;
    const abs = path.posix.normalize(path.posix.join(fromDir, file));
    if (abs.startsWith('..')) return whole;
    if (abs.startsWith('docs/guide/') && abs.endsWith('.md')) {
      const rel = abs.slice('docs/guide/'.length);
      if (isPublished(rel)) return `](${hrefFor(slugFor(rel))}${hash})`;
    }
    return `](${GITHUB_BLOB}${abs}${hash})`;
  });
}

function listGuideFiles() {
  const out = [];
  if (fs.existsSync(path.join(GUIDE_ROOT, HOME_FILE))) out.push(HOME_FILE);
  for (const { dir } of SECTIONS) {
    const abs = path.join(GUIDE_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      if (f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.')) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

/** Every published guide page: { id, rel, title, description, body }. */
export function guidePages() {
  return listGuideFiles().map((rel) => {
    const raw = fs.readFileSync(path.join(GUIDE_ROOT, rel), 'utf8');
    const { title, body } = titleAndBody(raw);
    return {
      id: slugFor(rel),
      rel,
      title,
      description: descriptionOf(body),
      body: rewriteLinks(body, `docs/guide/${rel}`),
    };
  });
}

/**
 * Release notes, one page per minor version, newest first. CHANGELOG.md is
 * the live source (docs/_changelog stopped being written at 0.232.35).
 */
export function changelogPages() {
  if (!fs.existsSync(CHANGELOG_FILE)) return [];
  const raw = fs.readFileSync(CHANGELOG_FILE, 'utf8');
  const parts = raw.split(/^(?=## v?\d+\.\d+\.\d+)/m).slice(1);
  const byMinor = new Map();
  for (const part of parts) {
    const m = /^## v?(\d+)\.(\d+)\.(\d+)/.exec(part);
    if (!m) continue;
    const minor = `${m[1]}.${m[2]}`;
    if (!byMinor.has(minor)) byMinor.set(minor, []);
    byMinor.get(minor).push(part.trimEnd());
  }
  const pages = [...byMinor.entries()].map(([minor, entries]) => ({
    id: `changelog/v${minor.replace('.', '-')}`,
    title: `Release ${minor}`,
    description: `Changes in Mantle ${minor}.x.`,
    body: rewriteLinks(entries.join('\n\n'), 'CHANGELOG.md'),
    minor,
  }));
  const index = {
    id: 'changelog',
    title: 'Changelog',
    description: 'What changed in each Mantle release, newest first.',
    body:
      'What changed in each Mantle release, newest first.\n\n' +
      pages.map((p) => `- [${p.minor}](${hrefFor(p.id)})`).join('\n') +
      '\n',
  };
  return [index, ...pages];
}

const MCP_TOOLS_FILE = fileURLToPath(new URL('../data/mcp-tools.json', import.meta.url));

/**
 * The MCP tool reference, from src/data/mcp-tools.json, which
 * scripts/mcp-tools.ts writes from the real server at build. Absent file
 * (no mantle workspace install) means no page, never a stale one.
 */
export function mcpToolsPage() {
  if (!fs.existsSync(MCP_TOOLS_FILE)) return null;
  const tools = JSON.parse(fs.readFileSync(MCP_TOOLS_FILE, 'utf8'));
  const groups = new Map();
  for (const t of tools) {
    const prefix = t.name.split('_')[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(t);
  }
  const cell = (text) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const firstSentence = (d) => {
    const m = /^(.+?[.!?])(\s|$)/.exec(d.trim());
    return cell(m ? m[1] : d);
  };
  let body =
    `Every tool the Mantle MCP server offers, ${tools.length} in all, made from the server code at build. ` +
    'A login sees only the tools its access allows. See [Connect Claude over MCP](/api/connect-claude/).\n';
  for (const [prefix, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    body += `\n## ${prefix}\n\n| Tool | What it does |\n|---|---|\n`;
    for (const t of list) body += `| \`${t.name}\` | ${firstSentence(t.description)} |\n`;
  }
  return {
    id: 'api/mcp-tools',
    title: 'MCP tools',
    description: 'Every tool the Mantle MCP server offers.',
    body,
  };
}

/** Sidebar for astro.config: sections from the guide, then the changelog. */
export function sidebar() {
  const pages = guidePages();
  const itemsFor = (dir) =>
    pages
      .filter((p) => p.rel.startsWith(`${dir}/`))
      .map((p) => ({ label: p.title, link: hrefFor(p.id) }));
  const groups = [];
  for (const s of SECTIONS) {
    if (s.parent) continue;
    const items = itemsFor(s.dir);
    for (const child of SECTIONS.filter((c) => c.parent === s.dir)) {
      const childItems = itemsFor(child.dir);
      if (childItems.length) items.push({ label: child.label, collapsed: true, items: childItems });
    }
    if (s.dir === '07-api' && mcpToolsPage()) items.push({ label: 'MCP tools', link: '/api/mcp-tools/' });
    if (items.length) groups.push({ label: s.label, items });
  }
  groups.push({ label: 'Changelog', link: '/changelog/' });
  return groups;
}
