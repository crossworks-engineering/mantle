import { notFound, redirect } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { getNote } from '@/lib/notes';

/**
 * Deep link to a single note. Notes now live on one resizable screen with an
 * in-pane editor, so a direct `/notes/[id]` URL redirects into `/notes` with
 * that note selected and opened straight in the (full-bleed) editor — no
 * separate boxed detail page, no preview-then-edit double step.
 */
export default async function NoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireOwner();
  const { id } = await params;
  const row = await getNote(user.id, id);
  if (!row) notFound();
  redirect(`/notes?selected=${id}&edit=1`);
}
