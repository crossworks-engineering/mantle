'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRealtime } from '@/components/realtime/use-realtime';
import type { DocRow } from '@/lib/docs';

export function DocsClient({
  docs,
  initialSelectedId,
}: {
  docs: DocRow[];
  initialSelectedId: string | null;
}) {
  const router = useRouter();
  // Live: a reconcile / edit on disk repaints the list + body.
  useRealtime(['documentation'], () => router.refresh());

  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId && docs.some((d) => d.id === initialSelectedId)
      ? initialSelectedId
      : (docs[0]?.id ?? null),
  );
  const selected = docs.find((d) => d.id === selectedId) ?? docs[0] ?? null;

  // Group by collection for the left rail.
  const groups = useMemo(() => {
    const m = new Map<string, DocRow[]>();
    for (const d of docs) {
      const list = m.get(d.collection) ?? [];
      list.push(d);
      m.set(d.collection, list);
    }
    return [...m.entries()];
  }, [docs]);

  if (docs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <BookText className="mx-auto mb-4 size-10 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            No documentation indexed yet. Enable a collection at{' '}
            <Link href="/settings/documentation" className="font-medium text-foreground underline">
              Settings → Documentation
            </Link>{' '}
            to index your docs into the brain.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* LEFT: list */}
      <div className="flex flex-col border-b md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between p-3">
          <h2 className="text-sm font-semibold">Docs</h2>
          <span className="text-xs text-muted-foreground">{docs.length}</span>
        </div>
        <div className="space-y-3 p-3 pt-0 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {groups.map(([collection, rows]) => (
            <div key={collection} className="space-y-1">
              <p className="px-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {collection}
              </p>
              {rows.map((d) => {
                const active = d.id === selected?.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSelectedId(d.id)}
                    className={cn(
                      'w-full rounded-md border-l-[3px] px-3 py-2 text-left text-sm transition-colors',
                      active
                        ? 'border-l-primary bg-muted/40 font-medium'
                        : 'border-l-transparent hover:bg-muted/50',
                    )}
                  >
                    <span className="block truncate">{d.relPath}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT: rendered markdown */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <article className="mx-auto max-w-3xl px-6 py-8 md:py-12">
            <p className="mb-2 text-xs text-muted-foreground">
              {selected.collection} · {selected.relPath}
            </p>
            <div className="prose dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content}</ReactMarkdown>
            </div>
          </article>
        ) : null}
      </div>
    </div>
  );
}
