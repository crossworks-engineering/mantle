'use client';

import { useEffect, useState } from 'react';
import { Download, Eye, FileText, PencilLine, Save, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

type FetchResponse =
  | { file: FileRow; content?: string }
  | { error: string };

export function FileEditor({
  fileId,
  onClose,
  onSaved,
}: {
  fileId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'loaded'; file: FileRow; content: string }
  >({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'edit' | 'preview' | 'split'>('split');
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/files/files/${fileId}`);
        const body = (await res.json()) as FetchResponse;
        if (cancelled) return;
        if (!res.ok || 'error' in body) {
          setState({
            kind: 'error',
            message: 'error' in body ? body.error : `request failed (${res.status})`,
          });
          return;
        }
        const content = body.content ?? '';
        setState({ kind: 'loaded', file: body.file, content });
        setDraft(content);
        setDirty(false);
      } catch (err) {
        if (cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const save = async () => {
    if (state.kind !== 'loaded') return;
    setSaving(true);
    try {
      const res = await fetch(`/api/files/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: b.error ?? 'save failed' });
        return;
      }
      setDirty(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const submitRename = async () => {
    if (state.kind !== 'loaded') return;
    setSaving(true);
    try {
      const res = await fetch(`/api/files/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rename: renameDraft }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: b.error ?? 'rename failed' });
        return;
      }
      const { file } = (await res.json()) as { file: FileRow };
      setState({ kind: 'loaded', file, content: draft });
      setRenaming(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{state.message}</p>
        <button onClick={onClose} className="rounded-md border border-input px-3 py-1 text-xs">
          Close
        </button>
      </div>
    );
  }

  const { file } = state;
  const isMarkdown = file.extension === 'md' || file.extension === 'markdown';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-border px-6 py-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        {renaming ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-0.5 text-sm"
              placeholder="new-name (extension preserved)"
            />
            <span className="text-xs text-muted-foreground">.{file.extension}</span>
            <button
              onClick={submitRename}
              disabled={saving}
              className="rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
            >
              Rename
            </button>
            <button
              onClick={() => setRenaming(false)}
              className="rounded-md border border-input px-2 py-0.5 text-xs"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              const stem =
                file.filename.lastIndexOf('.') > 0
                  ? file.filename.slice(0, file.filename.lastIndexOf('.'))
                  : file.filename;
              setRenameDraft(stem);
              setRenaming(true);
            }}
            className="text-sm font-medium hover:underline"
            title="Click to rename (basename only)"
          >
            {file.filename}
          </button>
        )}
        <span className="text-xs text-muted-foreground">
          {file.parentPath} · {file.mimeType}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {isMarkdown && (
            <div className="flex rounded-md border border-input p-0.5 text-xs">
              <ViewToggle
                label="Edit"
                icon={<PencilLine className="size-3" />}
                active={mode === 'edit'}
                onClick={() => setMode('edit')}
              />
              <ViewToggle
                label="Split"
                active={mode === 'split'}
                onClick={() => setMode('split')}
              />
              <ViewToggle
                label="Preview"
                icon={<Eye className="size-3" />}
                active={mode === 'preview'}
                onClick={() => setMode('preview')}
              />
            </div>
          )}
          <a
            href={`/api/files/files/${file.id}?raw=1`}
            download={file.filename}
            className="rounded-md border border-input px-2 py-1 text-xs font-medium hover:bg-accent"
            title="Download"
          >
            <Download className="size-3.5" aria-hidden />
          </a>
          {file.isText && (
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              <Save className="size-3.5" /> {saving ? '…' : 'Save'}
              {dirty && <span className="ml-0.5 text-[10px]">•</span>}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-input px-2 py-1 text-xs"
            title="Close"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </header>

      {/* Body */}
      {file.isText ? (
        <div className="flex flex-1 overflow-hidden">
          {(mode === 'edit' || mode === 'split' || !isMarkdown) && (
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setDirty(e.target.value !== state.content);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault();
                  void save();
                }
              }}
              className={
                'h-full resize-none border-0 bg-background p-4 font-mono text-sm focus:outline-none ' +
                (mode === 'split' && isMarkdown ? 'w-1/2 border-r border-border' : 'flex-1')
              }
              spellCheck={file.extension !== 'json'}
            />
          )}
          {isMarkdown && (mode === 'preview' || mode === 'split') && (
            <article
              className={
                'h-full overflow-y-auto p-6 prose prose-sm dark:prose-invert max-w-none ' +
                (mode === 'split' ? 'w-1/2' : 'flex-1')
              }
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
            </article>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>Binary file — preview not available.</p>
          <a
            href={`/api/files/files/${file.id}?raw=1`}
            download={file.filename}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
          >
            Download {file.filename}
          </a>
          {file.summary && (
            <p className="max-w-md text-center text-xs italic">{file.summary}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ViewToggle({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'flex items-center gap-1 rounded px-2 py-0.5 ' +
        (active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')
      }
    >
      {icon}
      {label}
    </button>
  );
}
