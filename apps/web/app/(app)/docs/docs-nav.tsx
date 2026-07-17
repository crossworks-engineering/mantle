'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
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

/** Disclosure chevron that rotates when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'size-3.5 shrink-0 text-muted-foreground transition-transform',
        open && 'rotate-90',
      )}
      aria-hidden
    />
  );
}

function TreeItems({
  nodes,
  collectionKey,
  parentPath,
  activePath,
  depth,
  isOpen,
  toggle,
}: {
  nodes: TreeNode[];
  collectionKey: string;
  parentPath: string;
  activePath: string;
  depth: number;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => {
        const padLeft = `${depth * 0.75 + 0.25}rem`;
        if (node.relPath === undefined) {
          // folder — collapsible
          const folderPath = parentPath ? `${parentPath}/${node.name}` : node.name;
          const id = `${collectionKey}::${folderPath}`;
          const open = isOpen(id);
          return (
            <li key={`d:${node.name}`}>
              <button
                type="button"
                onClick={() => toggle(id)}
                aria-expanded={open}
                style={{ paddingLeft: padLeft }}
                className="flex w-full items-center gap-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
              >
                <Chevron open={open} />
                {prettifyDocLabel(node.name)}
              </button>
              {open && (
                <TreeItems
                  nodes={node.children}
                  collectionKey={collectionKey}
                  parentPath={folderPath}
                  activePath={activePath}
                  depth={depth + 1}
                  isOpen={isOpen}
                  toggle={toggle}
                />
              )}
            </li>
          );
        }
        const href = `/docs/${encodeURIComponent(collectionKey)}/${encodeRelPath(node.relPath)}`;
        const active = activePath === href;
        return (
          <li key={`f:${node.relPath}`}>
            <Link
              href={href}
              style={{ paddingLeft: padLeft }}
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

  // Collapsed section/folder ids. Empty = all expanded. Persists while the nav
  // stays mounted (across in-/docs navigation, since it lives in the layout).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isOpen = (id: string) => !collapsed.has(id);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Auto-open the active doc's collection + ancestor folders so navigating
  // always reveals the current page, even if its section was collapsed.
  useEffect(() => {
    const m = pathname.match(/^\/docs\/([^/]+)\/(.+)$/);
    const collEnc = m?.[1];
    const relEnc = m?.[2];
    if (!collEnc || !relEnc) return;
    const collKey = decodeURIComponent(collEnc);
    const segs = relEnc.split('/').map(decodeURIComponent);
    const ancestors = new Set<string>([collKey]);
    let acc = '';
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      acc = acc ? `${acc}/${seg}` : seg;
      ancestors.add(`${collKey}::${acc}`);
    }
    setCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const a of ancestors) if (next.delete(a)) changed = true;
      return changed ? next : prev;
    });
  }, [pathname]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between p-3">
        <Link href="/docs" className="text-sm font-semibold hover:underline">
          Documentation
        </Link>
      </div>
      <nav className="space-y-3 p-3 pt-0 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
        {nav.map((col) => {
          const open = isOpen(col.key);
          return (
            <div key={col.key} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => toggle(col.key)}
                  aria-expanded={open}
                  className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
                >
                  <Chevron open={open} />
                  <span className="truncate text-xs font-semibold text-foreground">
                    {col.label}
                  </span>
                </button>
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
              {open &&
                (col.files.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No documents.</p>
                ) : (
                  <TreeItems
                    nodes={buildTree(col.files)}
                    collectionKey={col.key}
                    parentPath=""
                    activePath={pathname}
                    depth={0}
                    isOpen={isOpen}
                    toggle={toggle}
                  />
                ))}
            </div>
          );
        })}
      </nav>
    </div>
  );
}
