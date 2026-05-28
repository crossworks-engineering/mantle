'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ChevronDown,
  ChevronRight,
  FileJson,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { FileEditor } from './file-editor';
import { formatDate } from '@/lib/format-datetime';
import { SetPageTitle } from '@/components/layout/page-title';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/components/ui/toast';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

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

type TextExt = 'md' | 'txt' | 'json';

const FILES_ROOT = 'files';

/** Normalize a free-typed folder name into a slug (lowercase, dashes). */
function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

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
  const toast = useToast();
  const [files, setFiles] = useState<FileRow[]>(initialFiles);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [busy, startTransition] = useTransition();

  // Dialog open-state.
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFileExt, setCreateFileExt] = useState<TextExt | null>(null);
  const [deleteFolderOpen, setDeleteFolderOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Sync local file state when server re-fetches.
  useEffect(() => {
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

  // ─── Upload ──────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const triggerUpload = () => fileInputRef.current?.click();
  const uploadFiles = async (input: FileList | File[]) => {
    let failed = false;
    for (const file of Array.from(input)) {
      const form = new FormData();
      form.set('parentPath', currentPath);
      form.set('file', file);
      const res = await fetch('/api/files/files', { method: 'POST', body: form });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(`${file.name}: ${b.error ?? 'upload failed'}`);
        failed = true;
        break;
      }
    }
    if (!failed) toast.success('Upload complete');
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
  const confirmDeleteFolder = async () => {
    if (!currentFolder || currentFolder.path === FILES_ROOT) return;
    const res = await fetch(`/api/files/folders/${currentFolder.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Delete failed');
      return;
    }
    toast.success(`Deleted "${currentFolder.slug}"`);
    const parent =
      currentFolder.path.lastIndexOf('.') > 0
        ? currentFolder.path.slice(0, currentFolder.path.lastIndexOf('.'))
        : FILES_ROOT;
    navigateFolder(parent);
  };

  // ─── Bulk delete files ───────────────────────────────────────────
  const confirmBulkDelete = async () => {
    if (selectedFileIds.size === 0) return;
    const ids = Array.from(selectedFileIds);
    const res = await fetch('/api/files/files', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Delete failed');
      return;
    }
    toast.success(`Deleted ${ids.length} file${ids.length === 1 ? '' : 's'}`);
    setSelectedFileIds(new Set());
    refresh();
  };

  // ─── Folder description inline edit ──────────────────────────────
  const [editingDesc, setEditingDesc] = useState(false);
  const [draftDesc, setDraftDesc] = useState(currentFolder?.description ?? '');
  const saveDescription = async () => {
    if (!currentFolder) return;
    const res = await fetch(`/api/files/folders/${currentFolder.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: draftDesc }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Could not save description');
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

  const allSelected = files.length > 0 && selectedFileIds.size === files.length;
  const someSelected = selectedFileIds.size > 0 && !allSelected;

  return (
    <div className="grid h-full grid-cols-[260px_1fr]">
      {/* ── Tree rail ───────────────────────────────────────────── */}
      <aside className="overflow-y-auto border-r border-border bg-muted/20 p-2">
        <FolderTreeRail tree={tree} currentPath={currentPath} onNavigate={navigateFolder} />
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
          <FileEditor key={openFileId} fileId={openFileId} onClose={() => openFile(null)} onSaved={refresh} />
        ) : (
          <>
            <SetPageTitle title={currentFolder?.slug ?? 'files'} />
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

              {currentFolder && currentFolder.path !== FILES_ROOT && (
                <div className="mt-1 flex items-center justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-destructive hover:text-destructive"
                    onClick={() => setDeleteFolderOpen(true)}
                    disabled={busy}
                  >
                    <Trash2 /> Delete folder
                  </Button>
                </div>
              )}

              {/* Description */}
              <div className="mt-2 text-sm">
                {editingDesc ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      value={draftDesc}
                      onChange={(e) => setDraftDesc(e.target.value)}
                      rows={2}
                      placeholder="Describe what lives in this folder…"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveDescription}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingDesc(false);
                          setDraftDesc(currentFolder?.description ?? '');
                        }}
                      >
                        Cancel
                      </Button>
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm">
                    <Plus /> New <ChevronDown className="opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem onSelect={() => setCreateFolderOpen(true)}>
                    <FolderPlus /> Folder
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setCreateFileExt('md')}>
                    <FileText /> Markdown file
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCreateFileExt('txt')}>
                    <FileText /> Text file
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCreateFileExt('json')}>
                    <FileJson /> JSON file
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button size="sm" variant="outline" onClick={triggerUpload}>
                <Upload /> Upload
              </Button>
              <input ref={fileInputRef} type="file" multiple hidden onChange={onFileInput} />

              {selectedFileIds.size > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto text-destructive hover:text-destructive"
                  onClick={() => setBulkDeleteOpen(true)}
                >
                  <Trash2 /> Delete {selectedFileIds.size}
                </Button>
              )}
            </div>

            {/* Grid */}
            <div className="relative flex-1 overflow-y-auto">
              {dragOver && (
                <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary/50 bg-primary/5 text-sm font-medium text-primary">
                  Drop to upload to <code className="ml-1 font-mono">{currentPath}</code>
                </div>
              )}

              {/* Child folders */}
              <ChildFolders tree={tree} currentPath={currentPath} onNavigate={navigateFolder} />

              {/* Files */}
              {files.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                  No files in this folder. Drop a file anywhere here, or use{' '}
                  <span className="font-medium text-foreground">New</span> to create one.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="w-8 px-3 py-2">
                        <Checkbox
                          aria-label="Select all files"
                          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                          onCheckedChange={(v) =>
                            setSelectedFileIds(v ? new Set(files.map((f) => f.id)) : new Set())
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
                          <Checkbox
                            aria-label={`Select ${f.filename}`}
                            checked={selectedFileIds.has(f.id)}
                            onCheckedChange={(v) =>
                              setSelectedFileIds((prev) => {
                                const next = new Set(prev);
                                if (v) next.add(f.id);
                                else next.delete(f.id);
                                return next;
                              })
                            }
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

      {/* ── Create folder dialog ──────────────────────────────────── */}
      <CreateFolderDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        parentPath={currentPath}
        onCreated={refresh}
      />

      {/* ── Create file dialog ────────────────────────────────────── */}
      <CreateFileDialog
        ext={createFileExt}
        onOpenChange={(open) => !open && setCreateFileExt(null)}
        parentPath={currentPath}
        onCreated={(id) => {
          refresh();
          openFile(id);
        }}
      />

      {/* ── Delete folder confirm ─────────────────────────────────── */}
      <AlertDialog open={deleteFolderOpen} onOpenChange={setDeleteFolderOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder “{currentFolder?.slug}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The folder must be empty — move or delete its files first. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDeleteFolder}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Bulk delete confirm ───────────────────────────────────── */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedFileIds.size} file{selectedFileIds.size === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>This can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmBulkDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Create folder dialog ──────────────────────────────────────────
function CreateFolderDialog({
  open,
  onOpenChange,
  parentPath,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentPath: string;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setBusy(false);
    }
  }, [open]);

  const slug = slugify(name);
  const valid = slug.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const res = await fetch('/api/files/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentPath, slug, description }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Could not create folder');
      setBusy(false);
      return;
    }
    toast.success(`Created folder “${slug}”`);
    onOpenChange(false);
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Created inside <code className="font-mono">{parentPath}</code>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-folder"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Saved as <code className="font-mono">{slug || '…'}</code> — lowercase, dashes only.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="folder-desc">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="folder-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What lives in this folder?"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton pending={busy} disabled={!valid}>
              Create folder
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create file dialog ────────────────────────────────────────────
function CreateFileDialog({
  ext,
  onOpenChange,
  parentPath,
  onCreated,
}: {
  ext: TextExt | null;
  onOpenChange: (open: boolean) => void;
  parentPath: string;
  onCreated: (fileId: string) => void;
}) {
  const toast = useToast();
  const open = ext !== null;
  const [stem, setStem] = useState('');
  const [type, setType] = useState<TextExt>('md');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ext) {
      setStem('');
      setType(ext);
      setBusy(false);
    }
  }, [ext]);

  const cleanStem = stem.trim().replace(/\.[^.]*$/, '');
  const valid = cleanStem.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const res = await fetch('/api/files/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentPath,
        filename: `${cleanStem}.${type}`,
        content: defaultBodyFor(type),
      }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(b.error ?? 'Could not create file');
      setBusy(false);
      return;
    }
    const { file } = (await res.json()) as { file: FileRow };
    toast.success(`Created ${file.filename}`);
    onOpenChange(false);
    onCreated(file.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New file</DialogTitle>
          <DialogDescription>
            Created inside <code className="font-mono">{parentPath}</code> and opened for editing.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={type}
              onValueChange={(v) => v && setType(v as TextExt)}
            >
              <ToggleGroupItem value="md">Markdown</ToggleGroupItem>
              <ToggleGroupItem value="txt">Text</ToggleGroupItem>
              <ToggleGroupItem value="json">JSON</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="file-stem">Filename</Label>
            <div className="flex items-center gap-2">
              <Input
                id="file-stem"
                value={stem}
                onChange={(e) => setStem(e.target.value)}
                placeholder="untitled"
                autoFocus
              />
              <span className="shrink-0 text-sm text-muted-foreground">.{type}</span>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton pending={busy} disabled={!valid}>
              Create file
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{f.description}</div>
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

function defaultBodyFor(ext: TextExt): string {
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
  return formatDate(iso);
}
