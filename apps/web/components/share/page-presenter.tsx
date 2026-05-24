import { renderPageDoc } from '@/lib/render-page-doc';

/**
 * Public page render. Server-rendered sanitized HTML (see render-page-doc.ts)
 * dropped into a `.ProseMirror .prose` container so it reuses the editor CSS in
 * globals.css — callouts, columns, tables, task-lists, code highlight, KaTeX,
 * images all render exactly as in the app. Centered reading column; width
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
  const widthClass = view.width === 'wide' ? 'max-w-5xl' : 'max-w-3xl';
  return (
    <article className={`mx-auto ${widthClass} px-6 py-12 md:py-16`}>
      <header className="mb-8">
        {view.icon && <div className="mb-3 text-4xl leading-none">{view.icon}</div>}
        <h1 className="text-3xl font-bold tracking-tight text-balance">{view.title}</h1>
      </header>
      <div
        className="ProseMirror prose dark:prose-invert max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}
