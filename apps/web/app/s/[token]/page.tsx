import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { shareModeOf } from '@mantle/content';
import { resolveActiveShareByToken, recordShareView, loadShareView } from '@/lib/shares';
import { resolveShareVisitor } from '@/lib/team-gate';
import { TeamTokenPrompt } from '@/components/share/team-token-prompt';
import { PagePresenter } from '@/components/share/page-presenter';
import { NotePresenter } from '@/components/share/note-presenter';
import { FilePresenter } from '@/components/share/file-presenter';
import { TaskPresenter } from '@/components/share/task-presenter';
import { EventPresenter } from '@/components/share/event-presenter';
import { AppPresenter } from '@/components/share/app-presenter';

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
  // Team-mode shares don't leak their title to anonymous crawlers/unfurlers —
  // metadata renders before the visitor gate, so it must stay generic.
  const gated = share ? shareModeOf(share) === 'team' : false;
  const view = share && !gated ? await loadShareView(share) : null;
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

  // Team-mode shares (any kind) gate on a live team session — the share's own
  // visitor cookie or the brain-level /team hub cookie; without one the
  // visitor gets the token prompt instead of the content. For apps this is
  // UX (the brokers are the wall); for pages/notes/files it IS the wall.
  const visitor = await resolveShareVisitor((await headers()).get('cookie'), share);
  if (!visitor) {
    const title = 'title' in view ? view.title : view.filename;
    return <TeamTokenPrompt shareToken={token} title={title} />;
  }

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
    case 'app':
      return <AppPresenter view={view} token={token} />;
    default:
      notFound();
  }
}
