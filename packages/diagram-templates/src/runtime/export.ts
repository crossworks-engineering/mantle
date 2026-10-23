/**
 * The exported SVG is the deliverable that goes into pages, PDF, Word,
 * email and public shares, shown through `<img>`. It must be static and
 * self-contained: no script, no event handler, no animation, no external
 * reference of any kind, system font stacks only, and an accessible name.
 * `svgDocument` writes the root; `checkStaticSvg` proves the rules on any
 * SVG text and is what the tests and the render harness run.
 */
import { el, esc, num } from './svg.ts';
import { PALETTE } from './style.ts';

export type SvgDocInput = {
  width: number;
  height: number;
  /** Short subject name (the `<title>`). */
  title: string;
  /** One sentence on what the drawing shows (the `<desc>`). */
  desc: string;
  /** Prefix for every id in the drawing, so two diagrams in one page never
   *  share an id. */
  idPrefix: string;
  /** Template name and version, written as a comment-free attribute. */
  generator: string;
  body: string;
  background?: string;
};

/** A safe id prefix from a title. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'diagram';
}

export function svgDocument(d: SvgDocInput): string {
  const titleId = `${d.idPrefix}-title`;
  const descId = `${d.idPrefix}-desc`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(d.width)} ${num(d.height)}" ` +
    `width="${num(d.width)}" height="${num(d.height)}" role="img" ` +
    `aria-labelledby="${esc(titleId)} ${esc(descId)}" data-generator="${esc(d.generator)}">` +
    el('title', { id: titleId }, esc(d.title)) +
    el('desc', { id: descId }, esc(d.desc)) +
    el('rect', {
      x: 0,
      y: 0,
      width: d.width,
      height: d.height,
      fill: d.background ?? PALETTE.paper,
    }) +
    d.body +
    `</svg>`
  );
}

const FORBIDDEN_ELEMENTS = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'image',
  'img',
  'a',
  'use',
  'link',
  'meta',
  'style',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  'video',
  'audio',
  'canvas',
  'feImage',
];

/**
 * Every way the SVG breaks the static contract, as readable problems. An
 * empty list means it is safe to store and show anywhere.
 */
export function checkStaticSvg(svg: string): string[] {
  const problems: string[] = [];
  const text = svg.trim();
  if (!/^<svg\b/.test(text)) problems.push('the document must start with the root <svg>.');
  if (!/<\/svg>\s*$/.test(text)) problems.push('the document must end with </svg>.');
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text)) {
    problems.push('no DOCTYPE, ENTITY or stylesheet processing instruction.');
  }
  for (const tag of FORBIDDEN_ELEMENTS) {
    if (new RegExp(`<${tag}[\\s/>]`, 'i').test(text)) problems.push(`forbidden element <${tag}>.`);
  }
  // Attribute checks read the tags only: escaped text such as a label that
  // says 'onload=' is just text.
  const tags = [...text.matchAll(/<[^>]+>/g)].map((m) => m[0]).join('\n');
  const onAttr = /\son[a-z]+\s*=/i.exec(tags);
  if (onAttr) problems.push(`event handler attribute '${onAttr[0].trim()}'.`);
  if (/javascript:/i.test(tags)) problems.push("a 'javascript:' URL.");
  for (const m of tags.matchAll(/\s(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    if (!m[1]!.startsWith('#')) problems.push(`external reference href="${m[1]}".`);
  }
  for (const m of tags.matchAll(/url\(\s*['"]?([^)'"]*)['"]?\s*\)/gi)) {
    if (!m[1]!.startsWith('#')) problems.push(`external reference url(${m[1]}).`);
  }
  // A <style> block is refused above; @import or @font-face can only hide
  // in a tag's style attribute.
  if (/@import|@font-face/i.test(tags)) problems.push('no @import or @font-face.');
  const root = /^<svg\b[^>]*>/.exec(text)?.[0] ?? '';
  for (const attr of [
    'xmlns="http://www.w3.org/2000/svg"',
    'viewBox=',
    'width=',
    'height=',
    'role="img"',
    'aria-labelledby=',
  ]) {
    if (!root.includes(attr)) problems.push(`the root <svg> needs ${attr.replace(/=$/, '')}.`);
  }
  // The title is the root's first child, then the desc.
  const afterRoot = text.slice(root.length);
  if (!/^<title\b[^>]*>[^<]+<\/title>/.test(afterRoot))
    problems.push('the first child must be a non-empty <title>.');
  if (!/^<title\b[^>]*>[^<]*<\/title><desc\b[^>]*>[^<]+<\/desc>/.test(afterRoot)) {
    problems.push('a non-empty <desc> must follow the <title>.');
  }
  for (const m of text.matchAll(/font-family="([^"]*)"/g)) {
    const fam = m[1]!;
    if (!/(serif|sans-serif|monospace)\s*$/.test(fam)) {
      problems.push(`font-family "${fam}" must end in a generic family (system stacks only).`);
    }
  }
  return [...new Set(problems)];
}
