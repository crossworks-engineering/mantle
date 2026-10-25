/**
 * A `pid` drawing set: one canvas that holds several P&ID pages (an
 * overview and the sheets behind it) and jumps between them.
 *
 *   { template: 'pid', title, description?, profile?, legendNames?, legend?,
 *     showTitle?, pages: [{ id, title?, data }] }
 *
 * Each page's `data` is ordinary `pid` data, checked by the same rules; the
 * set's `profile`, `legendNames`, `legend` and `showTitle` are its default.
 * Inside a set, an off-page connector may carry `link` (the page it
 * continues on) and `focus` (the element to show there), and a line may
 * carry a `more` marker ("+7 DEADLEGS") with the same pair. The check
 * resolves every link to its page number, so the drawing prints it as a
 * page reference ("see page 3: <title>"): the static export, which cannot
 * switch pages, still says where everything went.
 *
 * A link only ever switches the canvas's own page (browser.ts): nothing is
 * loaded and the window is never navigated.
 */
import { slugify, svgDocument } from '../../runtime/export.ts';
import { pageRef, stackPages, type StackPage } from '../../runtime/pages.ts';
import { el, textEl } from '../../runtime/svg.ts';
import { PALETTE } from '../../runtime/style.ts';
import {
  checkKeys,
  done,
  isObj,
  list,
  messageOf,
  newIssues,
  objects,
  str,
  suggest,
  type Checked,
  type Obj,
} from '../../runtime/validate.ts';
import { clipText, type Measurer } from '../../runtime/text.ts';
import type { PageFailure, RenderResult } from '../../types.ts';
import { renderPid } from './render.ts';
import {
  PAGE_ID,
  PID_LIMITS,
  PID_VERSION,
  validatePid,
  type LinkSite,
  type PidData,
} from './schema.ts';

export type PidPage = { id: string; title: string; data: PidData };
export type PidSet = { set: true; title: string; description?: string; pages: PidPage[] };
/** What the `pid` template takes: one drawing, or a set of them. */
export type PidInput = PidData | PidSet;

/** The pages a set holds, and the longest page title (the page bar's). */
export const SET_LIMITS = { pages: 40, pageTitle: 60 } as const;

/** The set's own fields; the four after `description` are page defaults. */
const SET_KEYS = [
  'template',
  'version',
  'title',
  'description',
  'profile',
  'legendNames',
  'legend',
  'showTitle',
  'pages',
];
const INHERITED = ['profile', 'legendNames', 'legend', 'showTitle'] as const;
/** A drawing's own fields, which belong in a page's data, not on the set. */
const DRAWING_KEYS = [
  'sheet',
  'equipment',
  'offpage',
  'lines',
  'tees',
  'instruments',
  'signals',
  'circuits',
];

export function isSetData(input: unknown): boolean {
  return isObj(input) && input.pages !== undefined;
}

export function isPidSet(d: PidInput): d is PidSet {
  return (d as PidSet).set === true;
}

export function validatePidSet(input: unknown): Checked<PidSet> {
  const issues = newIssues();
  if (!isObj(input)) return { ok: false, errors: ['data: must be a JSON object.'], warnings: [] };
  const d = input as Obj;
  const misplaced = Object.keys(d).filter((k) => DRAWING_KEYS.includes(k));
  for (const k of misplaced) {
    issues.errors.push(
      `${k}: a set holds its drawings in pages[].data; move '${k}' into the page it belongs to.`,
    );
  }
  checkKeys(
    Object.fromEntries(Object.entries(d).filter(([k]) => !misplaced.includes(k))),
    SET_KEYS,
    '',
    issues,
  );
  if (d.template !== undefined && d.template !== 'pid') {
    issues.errors.push(
      `template: this is the 'pid' template, the data says '${String(d.template)}'.`,
    );
  }
  const title = str(d, 'title', '', issues, { required: true, max: PID_LIMITS.text.title }) ?? '';
  const description = str(d, 'description', '', issues, {
    max: PID_LIMITS.text.description,
  });
  if (!description)
    issues.warnings.push(
      'description: add one sentence on what the set shows (screen readers read it).',
    );
  const rawPages = objects(
    list(d, 'pages', '', issues, { required: true, max: SET_LIMITS.pages }),
    'pages',
    issues,
  );
  if (Array.isArray(d.pages) && d.pages.length === 0)
    issues.errors.push('pages: at least one page, the first is the one shown on open.');

  type Read = { p: string; id: string; title: string; data?: PidData; sites: LinkSite[] };
  const read: Read[] = [];
  const seen = new Map<string, string>();
  /** A shared field's problem is said once, at the set's own path. */
  const sharedSaid = new Set<string>();
  for (const [p, page] of rawPages) {
    checkKeys(page, ['id', 'title', 'data'], p, issues);
    const id = str(page, 'id', p, issues, {
      required: true,
      max: 32,
      pattern: PAGE_ID,
      patternText: 'a page id (letters, digits, - . _)',
    });
    if (id && seen.has(id))
      issues.errors.push(`${p}.id: page id '${id}' is already used by ${seen.get(id)}.`);
    else if (id) seen.set(id, p);
    if (!isObj(page.data)) {
      issues.errors.push(
        `${p}.data: required, the page's pid data ({ title, equipment, lines, ... }).`,
      );
      continue;
    }
    const own = page.data;
    const merged: Obj = { ...own };
    const inherited = new Set<string>();
    for (const k of INHERITED) {
      if (own[k] === undefined && d[k] !== undefined) {
        merged[k] = d[k];
        inherited.add(k);
      }
    }
    const sites: LinkSite[] = [];
    const checked = validatePid(merged, { links: sites });
    const at = `${p}.data`;
    const place = (msg: string) => {
      const key = /^([A-Za-z]+)/.exec(msg)?.[1] ?? '';
      if (inherited.has(key)) {
        if (!sharedSaid.has(msg)) {
          sharedSaid.add(msg);
          return msg;
        }
        return null;
      }
      return msg.startsWith('data:') ? `${at}:${msg.slice(5)}` : `${at}.${msg}`;
    };
    for (const e of checked.ok ? [] : checked.errors) {
      const m = place(e);
      if (m) issues.errors.push(m);
    }
    for (const w of checked.warnings) {
      const m = place(w);
      if (m) issues.warnings.push(m);
    }
    const pageTitle = str(page, 'title', p, issues, { max: SET_LIMITS.pageTitle });
    const title =
      pageTitle ??
      (typeof own.title === 'string' && own.title
        ? own.title.slice(0, SET_LIMITS.pageTitle)
        : (id ?? p));
    if (id) read.push({ p, id, title, sites, ...(checked.ok ? { data: checked.data } : {}) });
  }

  // Every link names a page of the set, and its focus an element there.
  const pageNo = new Map(read.map((r, i) => [r.id, { n: i + 1, r }]));
  const elementsOf = (data: PidData) =>
    new Set([
      ...data.equipment.map((e) => e.id),
      ...data.offpage.map((o) => o.id),
      ...data.lines.map((l) => l.id),
      ...data.tees.map((t) => t.id),
    ]);
  for (const r of read) {
    for (const site of r.sites) {
      const path = `${r.p}.data.${site.path}`;
      const target = pageNo.get(site.link.page);
      if (!target) {
        const s = suggest(site.link.page, [...pageNo.keys()]);
        issues.errors.push(
          `${path}: no page '${site.link.page}'${s ? ` (did you mean '${s}'?)` : ''}; a link names a page id of this set.`,
        );
        continue;
      }
      if (target.r === r && !site.link.focus) {
        issues.errors.push(
          `${path}: links to its own page; give 'focus' (the element to show) or drop the link.`,
        );
        continue;
      }
      if (site.link.focus && target.r.data && !elementsOf(target.r.data).has(site.link.focus)) {
        const s = suggest(site.link.focus, [...elementsOf(target.r.data)]);
        issues.errors.push(
          `${path.replace(/\.link$/, '.focus')}: page '${site.link.page}' has no line, equipment, connector or tee '${site.link.focus}'${s ? ` (did you mean '${s}'?)` : ''}.`,
        );
        continue;
      }
      site.link.ref = pageRef(target.n, target.r.title);
    }
  }

  return done(issues, {
    set: true as const,
    title,
    ...(description ? { description } : {}),
    pages: read.map((r) => ({ id: r.id, title: r.title, data: r.data! })),
  });
}

/** A page that could not be drawn: a panel that says so, in place of the
 *  drawing, so the other pages (and the page bar's numbering) still stand. */
function failedPage(title: string, idPrefix: string, n: number, error: string): StackPage {
  const width = 640;
  const height = 180;
  const lines = [
    `Page ${n} could not be drawn.`,
    clipText(`The drawing's layout failed: ${error}`, 90),
    'The other pages are unaffected. This is a template bug; report it with the data.',
  ];
  const body = [
    el('rect', {
      x: 16,
      y: 16,
      width: width - 32,
      height: height - 32,
      rx: 6,
      fill: PALETTE.white,
      stroke: PALETTE.accent,
      'stroke-width': 1.5,
    }),
    textEl('nodeName', 36, 56, clipText(title, 60), { fill: PALETTE.ink }),
    ...lines.map((t, i) =>
      textEl('sublabel', 36, 86 + i * 22, t, { fill: i === 0 ? PALETTE.accent : PALETTE.ink }),
    ),
  ].join('');
  return {
    id: '',
    title,
    width,
    height,
    svg: svgDocument({
      width,
      height,
      title,
      desc: `Page ${n} (${title}) could not be drawn: ${clipText(error, 200)}`,
      idPrefix,
      generator: `mantle-diagram pid@${PID_VERSION} set`,
      body: el('g', { 'data-error': 'layout' }, body),
    }),
  };
}

/** Every page drawn on its own (what the canvas shows one at a time) and
 *  the whole set stacked (the static export). A page whose layout throws
 *  becomes an error panel and is reported in `failed` and the warnings;
 *  the other pages still draw. */
export function renderPidSet(set: PidSet, m: Measurer): RenderResult {
  const prefix = slugify(set.title);
  const warnings: string[] = [];
  const failed: PageFailure[] = [];
  const stats: Record<string, number> = { pages: set.pages.length };
  const pages: StackPage[] = set.pages.map((p, i) => {
    const idPrefix = `${prefix}-p${i + 1}`;
    let r: RenderResult;
    try {
      r = renderPid(p.data, m, { idPrefix });
    } catch (err) {
      const error = messageOf(err);
      const path = `pages[${i}].data`;
      failed.push({ page: p.id, path, error });
      warnings.push(
        `${path}: page '${p.id}' could not be drawn (${error}); its page shows this error in place of the drawing. This is a template bug; report it with the data.`,
      );
      return { ...failedPage(p.title, idPrefix, i + 1, error), id: p.id };
    }
    for (const w of r.warnings) warnings.push(`page '${p.id}': ${w}`);
    for (const [k, v] of Object.entries(r.stats)) stats[k] = (stats[k] ?? 0) + v;
    return { id: p.id, title: p.title, svg: r.svg, width: r.width, height: r.height };
  });
  const names = set.pages.map((p) => p.title).join(', ');
  const stacked = stackPages({
    title: set.title,
    desc:
      set.description ??
      `${set.title}: ${set.pages.length} page${set.pages.length === 1 ? '' : 's'} (${clipText(names, 200)}).`,
    idPrefix: prefix,
    generator: `mantle-diagram pid@${PID_VERSION} set`,
    pages,
  });
  return {
    svg: stacked.svg,
    width: stacked.width,
    height: stacked.height,
    warnings: [...new Set(warnings)],
    stats,
    pages,
    ...(failed.length ? { failed } : {}),
  };
}

/** The template's entry points: a set when the data has `pages`. */
export function validatePidInput(input: unknown): Checked<PidInput> {
  return isSetData(input) ? validatePidSet(input) : validatePid(input);
}

export function renderPidInput(data: PidInput, m: Measurer): RenderResult {
  return isPidSet(data) ? renderPidSet(data, m) : renderPid(data, m);
}
