import { notFound } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { getPage } from '@mantle/content';
import { renderPageDoc } from '@/lib/render-page-doc';

// Resolved per request against the live DB; never statically cached.
export const dynamic = 'force-dynamic';

/**
 * Owner-only print surface for a Page — no app chrome, just the content in the
 * shared `.ProseMirror .prose` container so it reuses the editor CSS from
 * globals.css. Headless Chromium (lib/render-pdf.ts) navigates here with the
 * owner's session cookie and print-to-PDFs it for the `?format=pdf` download.
 * Not linked from anywhere in the UI — it's the PDF render target.
 */
export default async function PrintPageRoute({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const page = await getPage(user.id, id);
  if (!page) notFound();

  // Same authed asset path the in-app editor uses (page-editor/image.ts), so
  // embedded images load under the forwarded owner cookie.
  const html = renderPageDoc(page.doc, {
    assetUrl: (fileId: string) => `/api/files/files/${fileId}?raw=1`,
  });
  const widthClass = page.width === 'wide' ? 'max-w-5xl' : 'max-w-3xl';

  return (
    <>
      {/* globals.css pins html/body to overflow:hidden for the app shell; a
          printed document needs natural height so Chromium paginates it all.
          Force a white page too — a PDF should print light regardless of theme. */}
      <style>{`html,body{overflow:visible!important;height:auto!important;background:#fff}`}</style>
      {/* WYSIWYG: render only the page content — no injected page-name heading,
          matching the public share surface (PagePresenter) and the Markdown
          export. Most pages already open with their own H1. */}
      <article className={`ProseMirror prose prose-accent mx-auto ${widthClass} px-10 py-8`}>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </>
  );
}
