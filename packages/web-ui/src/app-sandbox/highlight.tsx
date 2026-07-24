'use client';

/**
 * Shared syntax highlighter for mini-app source. Reuses the project's existing
 * `lowlight` (highlight.js) registry — the same one the Pages editor uses — so
 * token colours track the active theme via the `.code-view` CSS scope in
 * globals.css (no fixed colour scheme, no new dependency). Used by both the
 * read-only viewer and the editable CodeEditor (highlighted layer).
 *
 * The lowlight hast tree is walked into React directly (a tiny recursive
 * renderer) rather than via hast-util-to-jsx-runtime, so we don't lean on a
 * transitive dependency that pnpm wouldn't hoist for this package.
 */
import { Fragment, type ReactNode } from 'react';
import { common, createLowlight } from 'lowlight';

// Shared highlight.js registry (~35 common languages: ts, js, css, xml, json…).
const lowlight = createLowlight(common);

/** Map a file path to a highlight.js language id. highlight.js has no dedicated
 *  tsx/jsx/html grammars — the typescript/javascript/xml grammars cover them. */
export function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'tsx':
    case 'ts':
      return 'typescript';
    case 'jsx':
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'css':
      return 'css';
    case 'scss':
    case 'less':
      return ext;
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
      return 'xml';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return '';
  }
}

// Minimal hast shapes (what lowlight emits): text nodes and span elements.
type HastText = { type: 'text'; value: string };
type HastElement = {
  type: 'element';
  tagName: string;
  properties?: { className?: string[] | string };
  children: HastNode[];
};
type HastRoot = { type: 'root'; children: HastNode[] };
type HastNode = HastText | HastElement | HastRoot;

function renderHast(node: HastNode, key: number): ReactNode {
  if (node.type === 'text') return node.value;
  const children = node.children.map((c, i) => renderHast(c, i));
  if (node.type === 'root') return <Fragment key={key}>{children}</Fragment>;
  const className = Array.isArray(node.properties?.className)
    ? node.properties.className.join(' ')
    : node.properties?.className;
  return (
    <span key={key} className={className}>
      {children}
    </span>
  );
}

/** Highlight `content` (language inferred from `path`) into React nodes.
 *  Falls back to the raw string if highlighting ever throws. */
export function highlightToReact(path: string, content: string): ReactNode {
  const lang = languageFor(path);
  try {
    const tree = (lang && lowlight.registered(lang)
      ? lowlight.highlight(lang, content)
      : lowlight.highlightAuto(content)) as unknown as HastRoot;
    return tree.children.map((c, i) => renderHast(c, i));
  } catch {
    return content; // never let highlighting break the editor
  }
}
