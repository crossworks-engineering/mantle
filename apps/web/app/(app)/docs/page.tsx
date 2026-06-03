import Link from 'next/link';
import { BookText } from 'lucide-react';
import { requireOwner } from '@/lib/auth';
import { getReaderNav } from '@/lib/docs-reader';
import { Badge } from '@/components/ui/badge';

/** Docs landing: an overview + a card per registered collection (read from disk,
 *  so it works with zero indexing). Each card links into the collection's first
 *  doc. The left nav (shared layout) is the primary way to browse. */
export default async function DocsLanding() {
  const user = await requireOwner();
  const nav = await getReaderNav(user.id);
  const total = nav.reduce((n, c) => n + c.files.length, 0);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 md:py-12">
      <div className="mb-6 flex items-start gap-3">
        <BookText className="mt-1 size-7 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">Documentation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read and navigate every documentation collection — straight from disk, whether or not
            it&apos;s indexed into the brain. Use the list on the left, or pick a collection below.
          </p>
        </div>
      </div>

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          No documentation found on disk. Add a collection at{' '}
          <Link href="/settings/documentation" className="font-medium text-foreground underline">
            Settings → Documentation
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {nav.map((col) => {
            const first = col.files[0];
            const href = first
              ? `/docs/${encodeURIComponent(col.key)}/${first.split('/').map(encodeURIComponent).join('/')}`
              : null;
            const inner = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{col.label}</span>
                  <Badge variant={col.enabled ? 'default' : 'outline'} className="shrink-0 text-[10px]">
                    {col.enabled ? 'Indexed' : 'Not indexed'}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {col.files.length} {col.files.length === 1 ? 'document' : 'documents'}
                </p>
              </>
            );
            return href ? (
              <Link
                key={col.key}
                href={href}
                className="rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50"
              >
                {inner}
              </Link>
            ) : (
              <div key={col.key} className="rounded-lg border bg-card p-4 opacity-70">
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
