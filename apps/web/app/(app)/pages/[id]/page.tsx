import { notFound } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { getPage, listBacklinks } from '@/lib/pages';
import { PageDetailClient } from './page-detail-client';

export default async function PageEditorRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireOwner();
  const { id } = await params;
  const [row, backlinks] = await Promise.all([getPage(user.id, id), listBacklinks(user.id, id)]);
  if (!row) notFound();
  // No wrapper: the client owns its width (narrow/wide toggle) and the
  // chromeless canvas layout.
  return <PageDetailClient initial={row} backlinks={backlinks} />;
}
