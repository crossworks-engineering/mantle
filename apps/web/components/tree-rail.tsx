import { and, asc, eq } from 'drizzle-orm';
import { ChevronRight, Folder } from 'lucide-react';
import Link from 'next/link';
import { db, nodes } from '@mantle/db';

/**
 * Server component. Loads the user's top-level branches; deeper levels load
 * on demand (deferred to next iteration when we have any branches to descend
 * into).
 */
export async function TreeRail({ ownerId }: { ownerId: string }) {
  const branches = await db
    .select({ id: nodes.id, title: nodes.title, path: nodes.path })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'branch')))
    .orderBy(asc(nodes.path));

  if (branches.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        No branches yet. Connect an email account to get started.
      </p>
    );
  }

  return (
    <ul className="space-y-px text-sm">
      {branches.map((b) => (
        <li key={b.id}>
          <Link
            href={`/t/${b.path.split('.').join('/')}`}
            className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-accent"
          >
            <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
            <Folder className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="truncate">{b.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
