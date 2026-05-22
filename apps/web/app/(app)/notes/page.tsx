import { requireOwner } from '@/lib/auth';
import { countNotes, listNoteTags, listNotes } from '@/lib/notes';
import { SetPageTitle } from '@/components/layout/page-title';
import { NotesClient } from './notes-client';

const PAGE_SIZE = 50;

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; tag?: string; q?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;
  const tag = sp.tag?.trim() || undefined;

  const [notes, total, tags] = await Promise.all([
    listNotes(user.id, { query, tag, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countNotes(user.id, { query, tag }),
    listNoteTags(user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Notes" />
      <NotesClient
        notes={notes}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        tags={tags}
        activeTag={tag ?? null}
        query={query ?? ''}
      />
    </div>
  );
}
