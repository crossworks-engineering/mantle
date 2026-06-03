'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronRight, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useRealtime } from '@/components/realtime/use-realtime';
import { prettifyDocLabel } from '@/lib/docs-labels';
import type { ReaderNav } from '@/lib/docs-reader';

/** Encode a collection-relative path into URL path segments (preserve slashes). */
function encodeRelPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

type TreeNode = {
  name: string; // raw path segment
  relPath?: string; // set on file leaves
  children: TreeNode[];
};

/** Build a nested folder/file tree from flat, sorted collection-relative paths. */
function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode = { name: '', children: [] };
  for (const file of files) {
    const parts = file.split('/');
    let cur = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = cur.children.find(
        (c) => c.name === part && (isFile ? c.relPath !== undefined : c.relPath === undefined),
      );
      if (!child) {
        child = { name: part, children: [], ...(isFile ? { relPath: file } : {}) };
        cur.children.push(child);
      }
      cur = child;
    });
  }
  return root.children;
}

function TreeItems({
  nodes,
  collectionKey,
  activePath,
  depth,
}: {
  nodes: TreeNode[];
  collectionKey: string;
  activePath: string;
  depth: number;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => {
        const pad = { paddingLeft: `${depth * 0.75 + 0.25}rem` };
        if (node.relPath === undefined) {
          // folder
          return (
            <li key={`d:${node.name}`}>
              <div
                className="flex items-center gap-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                style={pad}
              >
                <ChevronRight className="size-3 shrink-0" aria-hidden />
                {prettifyDocLabel(node.name)}
              </div>
              <TreeItems
                nodes={node.children}
                collectionKey={collectionKey}
                activePath={activePath}
                depth={depth + 1}
              />
            </li>
          );
        }
        const href = `/docs/${encodeURIComponent(collectionKey)}/${encodeRelPath(node.relPath)}`;
        const active = activePath === href;
        return (
          <li key={`f:${node.relPath}`}>
            <Link
              href={href}
              style={pad}
              className={cn(
                'block truncate rounded-md border-l-[3px] py-1.5 pr-2 text-sm transition-colors',
                active
                  ? 'border-l-primary bg-muted/40 font-medium'
                  : 'border-l-transparent hover:bg-muted/50',
              )}
            >
              {prettifyDocLabel(node.name)}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function DocsNav({ nav }: { nav: ReaderNav }) {
  const router = useRouter();
  const pathname = usePathname();
  // Optional polish: flip the Indexed badge live when a reconcile happens.
  // Content itself is read from disk per navigation, so this isn't load-bearing.
  useRealtime(['documentation'], () => router.refresh());

  const decodedPath = useMemo(() => {
    // pathname is URL-encoded; our hrefs are too, so compare encoded forms.
    return pathname;
  }, [pathname]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between p-3">
        <Link href="/docs" className="text-sm font-semibold hover:underline">
          Documentation
        </Link>
        <Link
          href="/settings/documentation"
          className="text-muted-foreground hover:text-foreground"
          title="Manage indexing"
          aria-label="Manage documentation indexing"
        >
          <Settings2 className="size-4" />
        </Link>
      </div>
      <nav className="space-y-4 p-3 pt-0 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
        {nav.map((col) => (
          <div key={col.key} className="space-y-1">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="truncate text-xs font-semibold text-foreground">{col.label}</span>
              <Badge
                variant={col.enabled ? 'default' : 'outline'}
                className="shrink-0 text-[10px]"
                title={
                  col.enabled
                    ? 'Indexed — the assistant can search these docs'
                    : 'Not indexed — readable here, but the assistant can’t search them'
                }
              >
                {col.enabled ? 'Indexed' : 'Not indexed'}
              </Badge>
            </div>
            {col.files.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No documents.</p>
            ) : (
              <TreeItems
                nodes={buildTree(col.files)}
                collectionKey={col.key}
                activePath={decodedPath}
                depth={0}
              />
            )}
          </div>
        ))}
      </nav>
    </div>
  );
}
