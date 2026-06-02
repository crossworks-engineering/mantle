import { requireOwner } from '@/lib/auth';
import { countNotes, getNote, listNoteTags, listNotes } from '@/lib/notes';
import { SetPageTitle } from '@/components/layout/page-title';
import { NotesClient } from './notes-client';

const PAGE_SIZE = 50;

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; tag?: string; q?: string; selected?: string; edit?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;
  const tag = sp.tag?.trim() || undefined;
  const selectedId = sp.selected?.trim() || null;

  const [notes, total, tags] = await Promise.all([
    listNotes(user.id, { query, tag, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countNotes(user.id, { query, tag }),
    listNoteTags(user.id),
  ]);

  // Deep-link (`?selected=`) may point at a note outside this page slice —
  // fetch it so the right pane can open it even when it's not in the list.
  const initialSelectedNote =
    selectedId && !notes.some((n) => n.id === selectedId) ? await getNote(user.id, selectedId) : null;

  return (
    <>
      <SetPageTitle title="Notes" />
      <NotesClient
        notes={notes}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        tags={tags}
        activeTag={tag ?? null}
        query={query ?? ''}
        initialSelectedId={selectedId}
        initialSelectedNote={initialSelectedNote}
        initialEditing={sp.edit === '1'}
      />
    </>
  );
}
