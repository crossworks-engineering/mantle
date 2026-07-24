import { notFound } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { getReaderDoc } from '@/lib/docs-reader';
import { DocView } from '../../doc-view';

/**
 * One documentation page, read from disk. Slug is the collection-relative path
 * (incl. `.md`). `getReaderDoc` returns null for an unknown collection or a
 * file that fails the traversal/extension guard → 404 (the authoritative guard).
 */
export default async function DocPage({
  params,
}: {
  params: Promise<{ collection: string; slug: string[] }>;
}) {
  const user = await requireOwner();
  const { collection, slug } = await params;
  const relPath = slug.map((s) => decodeURIComponent(s)).join('/');
  const doc = await getReaderDoc(user.id, decodeURIComponent(collection), relPath);
  if (!doc) notFound();
  return <DocView doc={doc} />;
}
