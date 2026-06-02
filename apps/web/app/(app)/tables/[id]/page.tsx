import { notFound } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { getTable } from '@/lib/tables';
import { TableDetailClient } from './table-detail-client';

export default async function TableEditorRoute({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const row = await getTable(user.id, id);
  if (!row) notFound();
  return <TableDetailClient initial={row} />;
}
