'use client';

import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { prettifyDocLabel } from '@/lib/docs-labels';
import type { ReaderDoc } from '@/lib/docs-reader';

/** Resolve a relative posix path against a base dir, folding `.`/`..`.
 *  Returns null if it escapes the root (too many `..`). Browser-safe (no node:path). */
function posixResolve(baseDir: string, rel: string): string | null {
  const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null; // escapes the collection root
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}

function encodeRelPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

const MD_RE = /\.(md|markdown)$/i;

/** Build the ReactMarkdown component overrides for in-doc links, bound to the
 *  current doc's collection + path so relative `.md` links navigate in-app. */
function makeComponents(collectionKey: string, relPath: string): Components {
  const baseDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  return {
    a(props) {
      const { href, children } = props;
      const h = (href ?? '').trim();
      if (!h) return <a>{children}</a>;
      // External / mail / tel → new tab.
      if (/^(https?:|mailto:|tel:)/i.test(h)) {
        return (
          <a href={h} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }
      // In-page anchor or app-absolute path → leave as-is.
      if (h.startsWith('#')) return <a href={h}>{children}</a>;
      if (h.startsWith('/')) return <Link href={h}>{children}</Link>;

      // Relative link: split off #fragment, only rewrite markdown targets.
      const hashIdx = h.indexOf('#');
      const pathPart = hashIdx >= 0 ? h.slice(0, hashIdx) : h;
      const frag = hashIdx >= 0 ? h.slice(hashIdx) : '';
      // Non-markdown relative link (e.g. an asset) — render inert, don't 404 a route.
      if (!MD_RE.test(pathPart)) return <a>{children}</a>;
      const resolved = posixResolve(baseDir, pathPart);
      if (resolved === null) return <a>{children}</a>; // would escape the root
      const target = `/docs/${encodeURIComponent(collectionKey)}/${encodeRelPath(resolved)}${frag}`;
      return <Link href={target}>{children}</Link>;
    },
  };
}

function PageLink({ link, dir }: { link: ReaderDoc['prev']; dir: 'prev' | 'next' }) {
  if (!link) return <span />;
  const href = `/docs/${encodeURIComponent(link.collectionKey)}/${encodeRelPath(link.relPath)}`;
  return (
    <Link
      href={href}
      className="inline-flex max-w-[48%] items-center gap-1.5 truncate text-sm text-muted-foreground hover:text-foreground"
    >
      {dir === 'prev' && <ArrowLeft className="size-4 shrink-0" aria-hidden />}
      <span className="truncate">{link.label}</span>
      {dir === 'next' && <ArrowRight className="size-4 shrink-0" aria-hidden />}
    </Link>
  );
}

export function DocView({ doc }: { doc: ReaderDoc }) {
  const segments = doc.relPath.split('/');
  const components = makeComponents(doc.collectionKey, doc.relPath);

  return (
    <article className="mx-auto max-w-3xl px-6 py-8 md:py-12">
      <p className="mb-2 text-xs text-muted-foreground">
        {doc.collectionLabel}
        {segments.map((s, i) => (
          <span key={i}> · {prettifyDocLabel(s)}</span>
        ))}
      </p>
      <div className="prose dark:prose-invert max-w-none prose-accent">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {doc.content}
        </ReactMarkdown>
      </div>
      {(doc.prev || doc.next) && (
        <nav className="mt-12 flex items-center justify-between gap-4 border-t pt-4">
          <PageLink link={doc.prev} dir="prev" />
          <PageLink link={doc.next} dir="next" />
        </nav>
      )}
    </article>
  );
}
