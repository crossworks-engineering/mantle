import { requireOwner } from '@/lib/auth';
import { listNotes } from '@/lib/notes';
import { SetPageTitle } from '@/components/layout/page-title';
import { NotesClient } from './notes-client';

export default async function NotesPage() {
  const user = await requireOwner();
  const rows = await listNotes(user.id);
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Notes" />
      <NotesClient initialNotes={rows} />
    </div>
  );
}
