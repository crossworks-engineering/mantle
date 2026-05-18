'use client';

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { FileEditor } from './file-editor';

type FolderRow = {
  id: string;
  path: string;
  title: string;
  slug: string;
  description: string;
  childFolderCount: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
};

type FileRow = {
  id: string;
  parentPath: string;
  filename: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  isText: boolean;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

const FILES_ROOT = 'files';

export function FilesClient({
  tree,
  currentPath,
  currentFolder,
  files: initialFiles,
}: {
  tree: FolderRow[];
  currentPath: string;
  currentFolder: FolderRow | null;
  files: FileRow[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [files, setFiles] = useState<FileRow[]>(initialFiles);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, startTransition] = useTransition();

  // Sync local file state when server re-fetches.
  useMemo(() => {
    setFiles(initialFiles);
    setSelectedFileIds(new Set());
  }, [initialFiles]);

  const openFileId = searchParams.get('file');

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  const navigateFolder = (path: string) => {
    const sp = new URLSearchParams();
    sp.set('path', path);
    router.push(`/files?${sp.toString()}`);
  };

  const openFile = (fileId: string | null) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (fileId) sp.set('file', fileId);
    else sp.delete('file');
    router.push(`/files?${sp.toString()}`);
  };

  // ─── Create folder ───────────────────────────────────────────────
  const newFolder = async () => {
    const name = window.prompt('Folder name (lowercase, dashes allowed)');
    if (!name) return;
    const description = window.prompt('Description (optional)') ?? '';
    setError(undefined);
    const res = await fetch('/api/files/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentPath: currentPath, slug: name, description }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'create folder failed');
      return;
    }
    refresh();
  };

  // ─── Create text file ────────────────────────────────────────────
  const newTextFile = async (ext: 'md' | 'txt' | 'json') => {
    const stem = window.prompt(`New .${ext} filename (without extension)`);
    if (!stem) return;
    setError(undefined);
    const res = await fetch('/api/files/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentPath: currentPath,
        filename: `${stem}.${ext}`,
        content: defaultBodyFor(ext),
      }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'create file failed');
      return;
    }
    const { file } = (await res.json()) as { file: FileRow };
    refresh();
    // Open it for editing.
    openFile(file.id);
  };

  // ─── Upload ──────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const triggerUpload = () => fileInputRef.current?.click();
  const uploadFiles = async (input: FileList | File[]) => {
    setError(undefined);
    for (const file of Array.from(input)) {
      const form = new FormData();
      form.set('parentPath', currentPath);
      form.set('file', file);
      const res = await fetch('/api/files/files', { method: 'POST', body: form });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(`${file.name}: ${b.error ?? 'upload failed'}`);
        break;
      }
    }
    refresh();
  };
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    void uploadFiles(e.target.files);
    e.target.value = '';
  };

  // ─── Drag-drop ───────────────────────────────────────────────────
  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
  };

  // ─── Delete folder ───────────────────────────────────────────────
  const onDeleteFolder = async () => {
    if (!currentFolder || currentFolder.path === FILES_ROOT) return;
    if (
      !window.confirm(
        `Delete folder "${currentFolder.slug}"? It must be empty (move files first).`,
      )
    )
      return;
    setError(undefined);
    const res = await fetch(`/api/files/folders/${currentFolder.id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'delete failed');
      return;
    }
    // Navigate up to parent.
    const parent =
      currentFolder.path.lastIndexOf('.') > 0
        ? currentFolder.path.slice(0, currentFolder.path.lastIndexOf('.'))
        : FILES_ROOT;
    navigateFolder(parent);
  };

  // ─── Bulk delete files ───────────────────────────────────────────
  const onBulkDelete = async () => {
    if (selectedFileIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedFileIds.size} file(s)?`)) return;
    setError(undefined);
    const ids = Array.from(selectedFileIds);
    const res = await fetch('/api/files/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'bulk delete failed');
      return;
    }
    setSelectedFileIds(new Set());
    refresh();
  };

  // ─── Description inline edit ─────────────────────────────────────
  const [editingDesc, setEditingDesc] = useState(false);
  const [draftDesc, setDraftDesc] = useState(currentFolder?.description ?? '');
  const saveDescription = async () => {
    if (!currentFolder) return;
    setError(undefined);
    const res = await fetch(`/api/files/folders/${currentFolder.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: draftDesc }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? 'description save failed');
      return;
    }
    setEditingDesc(false);
    refresh();
  };

  // ─── Breadcrumbs ─────────────────────────────────────────────────
  const breadcrumbs = useMemo(() => {
    const segments = currentPath.split('.');
    const crumbs: { label: string; path: string }[] = [];
    for (let i = 0; i < segments.length; i++) {
      const path = segments.slice(0, i + 1).join('.');
      const label = i === 0 ? 'Files' : segments[i]!.replace(/_/g, '-');
      crumbs.push({ label, path });
    }
    return crumbs;
  }, [currentPath]);

  return (
    <div className="grid h-full grid-cols-[260px_1fr]">
      {/* ── Tree rail ───────────────────────────────────────────── */}
      <aside className="overflow-y-auto border-r border-border bg-muted/20 p-2">
        <FolderTreeRail
          tree={tree}
          currentPath={currentPath}
          onNavigate={navigateFolder}
        />
      </aside>

      {/* ── Main pane ───────────────────────────────────────────── */}
      <div
        className="flex h-full flex-col overflow-hidden"
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {openFileId ? (
          <FileEditor
            key={openFileId}
            fileId={openFileId}
            onClose={() => openFile(null)}
            onSaved={refresh}
          />
        ) : (
          <>
            {/* Header */}
            <header className="border-b border-border px-6 py-3">
              <nav className="flex items-center gap-1 text-sm text-muted-foreground">
                {breadcrumbs.map((c, i) => (
                  <span key={c.path} className="flex items-center gap-1">
                    {i > 0 && <ChevronRight className="size-3" aria-hidden />}
                    <button
                      onClick={() => navigateFolder(c.path)}
                      className={
                        i === breadcrumbs.length - 1
                          ? 'font-medium text-foreground'
                          : 'hover:text-foreground'
                      }
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </nav>

              <div className="mt-1 flex items-baseline justify-between gap-3">
                <h1 className="text-lg font-semibold">
                  {currentFolder?.slug ?? 'files'}
                </h1>
                {currentFolder && currentFolder.path !== FILES_ROOT && (
                  <button
                    onClick={onDeleteFolder}
                    className="text-xs text-destructive hover:underline"
                    disabled={busy}
                  >
                    Delete folder
                  </button>
                )}
              </div>

              {/* Description */}
              <div className="mt-2 text-sm">
                {editingDesc ? (
                  <div className="flex flex-col gap-1.5">
                    <textarea
                      value={draftDesc}
                      onChange={(e) => setDraftDesc(e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={saveDescription}
                        className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => {
                          setEditingDesc(false);
                          setDraftDesc(currentFolder?.description ?? '');
                        }}
                        className="rounded-md border border-input px-2 py-1 text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setDraftDesc(currentFolder?.description ?? '');
                      setEditingDesc(true);
                    }}
                    className="group flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <span>
                      {currentFolder?.description ? (
                        currentFolder.description
                      ) : (
                        <span className="italic">no description — click to add</span>
                      )}
                    </span>
                    <Pencil className="size-3 opacity-0 group-hover:opacity-100" aria-hidden />
                  </button>
                )}
              </div>
            </header>

            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2">
              <ToolbarButton onClick={newFolder} icon={<FolderPlus className="size-4" />}>
                New folder
              </ToolbarButton>
              <ToolbarButton
                onClick={() => newTextFile('md')}
                icon={<Plus className="size-4" />}
              >
                New markdown
              </ToolbarButton>
              <ToolbarButton
                onClick={() => newTextFile('txt')}
                icon={<Plus className="size-4" />}
              >
                New text
              </ToolbarButton>
              <ToolbarButton
                onClick={() => newTextFile('json')}
                icon={<Plus className="size-4" />}
              >
                New JSON
              </ToolbarButton>
              <ToolbarButton onClick={triggerUpload} icon={<Upload className="size-4" />}>
                Upload
              </ToolbarButton>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={onFileInput}
              />

              {selectedFileIds.size > 0 && (
                <button
                  onClick={onBulkDelete}
                  className="ml-auto flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/20"
                >
                  <Trash2 className="size-3.5" />
                  Delete {selectedFileIds.size}
                </button>
              )}
            </div>

            {error && (
              <p className="mx-6 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            {/* Grid */}
            <div className="relative flex-1 overflow-y-auto">
              {dragOver && (
                <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary/50 bg-primary/5 text-sm font-medium text-primary">
                  Drop to upload to <code className="ml-1 font-mono">{currentPath}</code>
                </div>
              )}

              {/* Child folders */}
              <ChildFolders
                tree={tree}
                currentPath={currentPath}
                onNavigate={navigateFolder}
              />

              {/* Files */}
              {files.length === 0 ? (
                <p className="px-6 py-6 text-sm text-muted-foreground">
                  No files in this folder. Drop a file anywhere here, or use the toolbar
                  to create one.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="w-8 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={
                            selectedFileIds.size > 0 &&
                            selectedFileIds.size === files.length
                          }
                          onChange={(e) =>
                            setSelectedFileIds(
                              e.target.checked
                                ? new Set(files.map((f) => f.id))
                                : new Set(),
                            )
                          }
                        />
                      </th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-right">Size</th>
                      <th className="px-3 py-2 text-left">Summary</th>
                      <th className="px-3 py-2 text-left">Modified</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {files.map((f) => (
                      <tr key={f.id} className="hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedFileIds.has(f.id)}
                            onChange={(e) => {
                              setSelectedFileIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(f.id);
                                else next.delete(f.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => openFile(f.id)}
                            className="flex items-center gap-2 text-left hover:underline"
                          >
                            <FileText className="size-4 shrink-0 text-muted-foreground" />
                            <span className="font-medium">{f.filename}</span>
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              {f.extension}
                            </span>
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {fmtSize(f.sizeBytes)}
                        </td>
                        <td className="max-w-[40ch] truncate px-3 py-2 text-xs text-muted-foreground">
                          {f.summary ?? <span className="italic">—</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {fmtRelative(f.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChildFolders({
  tree,
  currentPath,
  onNavigate,
}: {
  tree: FolderRow[];
  currentPath: string;
  onNavigate: (path: string) => void;
}) {
  const children = useMemo(
    () =>
      tree
        .filter((f) => {
          if (f.path === currentPath) return false;
          if (!f.path.startsWith(currentPath + '.')) return false;
          const rest = f.path.slice(currentPath.length + 1);
          return !rest.includes('.');
        })
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    [tree, currentPath],
  );

  if (children.length === 0) return null;

  return (
    <div className="px-6 py-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        Folders ({children.length})
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-3">
        {children.map((f) => (
          <li key={f.id}>
            <button
              onClick={() => onNavigate(f.path)}
              className="flex w-full items-start gap-2 rounded-md border border-border px-3 py-2 text-left hover:bg-muted/40"
            >
              <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{f.slug}</div>
                {f.description && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {f.description}
                  </div>
                )}
                <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {f.childFolderCount} folders · {f.fileCount} files
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FolderTreeRail({
  tree,
  currentPath,
  onNavigate,
}: {
  tree: FolderRow[];
  currentPath: string;
  onNavigate: (path: string) => void;
}) {
  // Sort by path so parents appear before children.
  const sorted = useMemo(() => [...tree].sort((a, b) => a.path.localeCompare(b.path)), [tree]);
  return (
    <ul className="text-sm">
      {sorted.map((f) => {
        const depth = (f.path.match(/\./g) ?? []).length;
        return (
          <li key={f.id} style={{ paddingLeft: depth * 12 }}>
            <Link
              href={`/files?path=${encodeURIComponent(f.path)}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(f.path);
              }}
              className={
                'flex items-center gap-1.5 rounded px-1.5 py-1 ' +
                (f.path === currentPath
                  ? 'bg-primary/10 font-semibold text-primary'
                  : 'hover:bg-muted/40')
              }
              title={f.description || undefined}
            >
              <Folder className="size-3.5 text-muted-foreground" />
              <span className="truncate">{f.path === FILES_ROOT ? 'files' : f.slug}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function ToolbarButton({
  children,
  icon,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent"
    >
      {icon}
      {children}
    </button>
  );
}

function defaultBodyFor(ext: 'md' | 'txt' | 'json'): string {
  if (ext === 'md') return '# Untitled\n\nWrite something.\n';
  if (ext === 'json') return '{\n  \n}\n';
  return '';
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtRelative(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
