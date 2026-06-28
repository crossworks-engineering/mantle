import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveActiveShareByToken, recordShareView, loadShareView } from '@/lib/shares';
import { PagePresenter } from '@/components/share/page-presenter';
import { NotePresenter } from '@/components/share/note-presenter';
import { FilePresenter } from '@/components/share/file-presenter';
import { TaskPresenter } from '@/components/share/task-presenter';
import { EventPresenter } from '@/components/share/event-presenter';

// Always dynamic — resolves a DB token per request; never statically cached
// (a revoked link must 404 immediately).
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const share = await resolveActiveShareByToken(token);
  const view = share ? await loadShareView(share) : null;
  const heading = (view ? ('title' in view ? view.title : view.filename) : null) ?? 'Shared';
  // Unlisted by default: tell crawlers not to index shared links, but still
  // emit OG/Twitter tags so a pasted link unfurls nicely in chat apps.
  return {
    title: `${heading} · Shared`,
    robots: { index: false, follow: false },
    openGraph: { title: heading, description: 'Shared via Mantle', type: 'article' },
    twitter: { card: 'summary', title: heading, description: 'Shared via Mantle' },
  };
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Invalid / revoked / expired all 404 — never reveal that a token existed.
  const share = await resolveActiveShareByToken(token);
  if (!share) notFound();
  const view = await loadShareView(share);
  if (!view) notFound();

  void recordShareView(share.id); // fire-and-forget view counter

  const assetUrl = (fileId: string) => `/s/${token}/a/${fileId}`;

  switch (view.kind) {
    case 'page':
      return <PagePresenter view={view} assetUrl={assetUrl} />;
    case 'note':
      return <NotePresenter view={view} />;
    case 'file':
      return <FilePresenter view={view} assetUrl={assetUrl} />;
    case 'task':
      return <TaskPresenter view={view} />;
    case 'event':
      return <EventPresenter view={view} />;
    default:
      notFound();
  }
}
