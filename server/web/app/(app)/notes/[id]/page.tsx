import { redirect } from 'next/navigation';
import { requireOwner } from '@/lib/auth';

/**
 * Deep link to a single note. Notes live on one resizable screen with an in-pane
 * editor, so a direct `/notes/[id]` URL just redirects into `/notes` with that
 * note selected + opened in the editor. The list resolves the note client-side
 * (`/api/notes/[id]`) and shows a not-found state if it's gone — no SSR DB read
 * needed here (Phase 2 · Task 4).
 */
export default async function NoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  redirect(`/notes?selected=${id}&edit=1`);
}
