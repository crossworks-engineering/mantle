import { buildPageToc } from '@mantle/content/page-toc';
import { renderPageDoc } from '@/lib/render-page-doc';
import { PageOutline } from '@/components/page-editor/page-outline';

/**
 * Public page render. Server-rendered sanitized HTML (see render-page-doc.ts)
 * dropped into a `.ProseMirror .prose` container so it reuses the editor CSS in
 * globals.css — callouts, asides, columns, tables, task-lists, code highlight,
 * KaTeX, images all render exactly as in the app. Centered reading column; width
 * respects the page's narrow/wide setting.
 */
export function PagePresenter({
  view,
  assetUrl,
}: {
  view: { title: string; icon: string | null; width: 'narrow' | 'wide'; doc: Record<string, unknown> };
  assetUrl: (fileId: string) => string;
}) {
  const html = renderPageDoc(view.doc, { assetUrl });
  const toc = buildPageToc(view.doc);
  const widthClass = view.width === 'wide' ? 'max-w-5xl' : 'max-w-3xl';
  // The page name is intentionally NOT rendered on the public surface — a
  // shared page shows only its content. (The title still drives the browser
  // tab / metadata in the route, just not an on-page heading.)
  return (
    <div className="flex w-full gap-8 px-6 py-12 md:py-16">
      {/* Floating outline (left rail, wide screens). Anchor-scrolls to
          headings/sub-pages by id (no client JS needed beyond scrollIntoView). */}
      {toc.length > 0 && (
        <aside className="hidden w-56 shrink-0 xl:block">
          <div className="sticky top-12 max-h-[calc(100dvh-6rem)] overflow-y-auto scrollbar-thin">
            <PageOutline entries={toc} />
          </div>
        </aside>
      )}
      <div className="min-w-0 flex-1">
        <article className={`mx-auto w-full ${widthClass}`}>
          <div
            className="ProseMirror prose dark:prose-invert prose-accent max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </article>
      </div>
    </div>
  );
}
