'use client';

/**
 * File-tree sidebar for the Apps code viewer. Turns the flat virtual file map
 * (keys like `App.tsx` or `components/Foo.tsx`) into a nested, indented tree:
 * folders first, then files, alphabetical at each level. Read-only navigation —
 * clicking a file selects it in the adjacent CodeView.
 */
import { Fragment } from 'react';
import { ChevronDown, FileCode } from 'lucide-react';
import { cn } from '@/lib/utils';

type TreeNode = {
  name: string;
  path: string;
  isFile: boolean;
  children: TreeNode[];
};

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isFile: false, children: [] };
  for (const p of paths) {
    const segs = p.split('/').filter(Boolean);
    let node = root;
    segs.forEach((seg, i) => {
      const isFile = i === segs.length - 1;
      let child = node.children.find((c) => c.name === seg && c.isFile === isFile);
      if (!child) {
        child = { name: seg, path: segs.slice(0, i + 1).join('/'), isFile, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) =>
      a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1,
    );
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function Row({
  node,
  depth,
  entry,
  activePath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  entry: string;
  activePath: string;
  onSelect: (path: string) => void;
}) {
  // 8px base + 14px per nesting level keeps deep trees scannable without runaway indent.
  const pad = depth * 14 + 8;

  if (!node.isFile) {
    return (
      <Fragment>
        <div
          className="flex items-center gap-1.5 py-1 pr-2 text-xs font-medium text-muted-foreground"
          style={{ paddingLeft: pad }}
        >
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          <span className="truncate">{node.name}</span>
        </div>
        {node.children.map((c) => (
          <Row
            key={c.path}
            node={c}
            depth={depth + 1}
            entry={entry}
            activePath={activePath}
            onSelect={onSelect}
          />
        ))}
      </Fragment>
    );
  }

  const active = node.path === activePath;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      title={node.path}
      className={cn(
        'flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-foreground hover:bg-foreground/[0.06]',
      )}
      style={{ paddingLeft: pad }}
    >
      <FileCode
        className={cn('size-3.5 shrink-0', active ? 'opacity-80' : 'opacity-50')}
      />
      <span className="truncate">{node.name}</span>
      {node.path === entry && (
        <span
          className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
          title="Entry file"
          aria-label="Entry file"
        />
      )}
    </button>
  );
}

export function FileTree({
  paths,
  entry,
  activePath,
  onSelect,
  className,
}: {
  paths: string[];
  entry: string;
  activePath: string;
  onSelect: (path: string) => void;
  className?: string;
}) {
  const tree = buildTree(paths);
  return (
    <div className={cn('min-h-0 overflow-y-auto bg-sidebar py-2', className)}>
      {tree.map((node) => (
        <Row
          key={node.path}
          node={node}
          depth={0}
          entry={entry}
          activePath={activePath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
