'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, UploadCloud, X } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { apiFetch } from '@mantle/web-ui/api-fetch';

/**
 * App-wide background file uploader. Lives in the persistent app shell so a
 * drop on /files keeps uploading while you navigate anywhere else in Mantle —
 * the upload loop no longer dies when the Files screen unmounts. Uploads run
 * with bounded concurrency, continue past individual failures, and surface
 * progress in a floating dock. A `beforeunload` guard covers the one case an
 * in-tab manager can't survive: a full reload / tab close.
 *
 * Each successful POST creates a `file` node → `node_ingested` → the realtime
 * layer refreshes /files live, so the manager never has to cross-talk to it.
 */
export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error';

export type UploadTask = {
  id: string;
  name: string;
  parentPath: string;
  status: UploadStatus;
  error?: string;
};

type UploadApi = {
  tasks: UploadTask[];
  active: boolean;
  enqueue: (input: FileList | File[], parentPath: string) => void;
  clearFinished: () => void;
};

const UploadContext = createContext<UploadApi | null>(null);

/** How many files upload at once. Sequential was slow for a 20-file batch. */
const CONCURRENCY = 3;

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const pendingRef = useRef(new Map<string, { file: File; parentPath: string }>());
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(0);
  const idRef = useRef(0);
  const uploadOneRef = useRef<(id: string) => Promise<void>>(undefined);

  const update = useCallback((id: string, patch: Partial<UploadTask>) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // Start as many uploads as concurrency allows. Calls the latest uploader via
  // a ref so pump/uploadOne can reference each other without a render cycle.
  const pump = useCallback(() => {
    while (runningRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const id = queueRef.current.shift()!;
      runningRef.current++;
      void uploadOneRef.current?.(id);
    }
  }, []);

  uploadOneRef.current = async (id: string) => {
    const entry = pendingRef.current.get(id);
    if (!entry) {
      runningRef.current = Math.max(0, runningRef.current - 1);
      pump();
      return;
    }
    update(id, { status: 'uploading' });
    try {
      const form = new FormData();
      form.set('parentPath', entry.parentPath);
      form.set('file', entry.file);
      // FormData body: apiFetch (NOT apiSend) so the multipart boundary survives.
      // It throws ApiError on non-2xx, so the old !res.ok branch folds into catch.
      await apiFetch('/api/files/files', { method: 'POST', body: form });
      update(id, { status: 'done' });
    } catch (err) {
      update(id, { status: 'error', error: err instanceof Error ? err.message : 'upload failed' });
    } finally {
      pendingRef.current.delete(id);
      runningRef.current = Math.max(0, runningRef.current - 1);
      pump();
    }
  };

  const enqueue = useCallback(
    (input: FileList | File[], parentPath: string) => {
      const files = Array.from(input).filter((f) => f.size > 0);
      if (files.length === 0) return;
      const fresh: UploadTask[] = [];
      for (const file of files) {
        const id = `u${idRef.current++}`;
        pendingRef.current.set(id, { file, parentPath });
        queueRef.current.push(id);
        fresh.push({ id, name: file.name, parentPath, status: 'pending' });
      }
      setTasks((ts) => [...ts, ...fresh]);
      pump();
    },
    [pump],
  );

  const clearFinished = useCallback(() => {
    setTasks((ts) => ts.filter((t) => t.status === 'pending' || t.status === 'uploading'));
  }, []);

  const active = useMemo(
    () => tasks.some((t) => t.status === 'pending' || t.status === 'uploading'),
    [tasks],
  );

  // Guard against losing in-flight uploads to a reload / tab close.
  useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);

  const api = useMemo<UploadApi>(
    () => ({ tasks, active, enqueue, clearFinished }),
    [tasks, active, enqueue, clearFinished],
  );

  return <UploadContext.Provider value={api}>{children}</UploadContext.Provider>;
}

export function useUploads(): UploadApi {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error('useUploads must be used inside <UploadProvider>');
  return ctx;
}

/**
 * Floating progress dock — rendered inside the shell so it inherits the
 * `--activity-w` rail var (sits just left of the live-activity column on lg).
 * Hidden when there's nothing to show.
 */
export function UploadDock() {
  const { tasks, active, clearFinished } = useUploads();
  const [collapsed, setCollapsed] = useState(false);

  if (tasks.length === 0) return null;

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'error').length;
  const finished = done + failed;
  const pct = total ? Math.round((finished / total) * 100) : 0;

  const heading = active
    ? `Uploading ${finished}/${total}…`
    : failed > 0
      ? `Uploaded ${done} · ${failed} failed`
      : `Uploaded ${done} file${done === 1 ? '' : 's'}`;

  return (
    <div className="pointer-events-auto w-full overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
      >
        {active ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
        ) : failed > 0 ? (
          <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{heading}</span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90',
          )}
          aria-hidden
        />
      </button>

      <div className="h-0.5 w-full bg-muted">
        <div
          className={cn('h-full transition-all', failed > 0 ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </div>

      {!collapsed && (
        <ul className="max-h-48 divide-y divide-border overflow-y-auto scrollbar-thin border-t border-border">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              {t.status === 'uploading' ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
              ) : t.status === 'done' ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-hidden />
              ) : t.status === 'error' ? (
                <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
              ) : (
                <UploadCloud className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate" title={t.name}>
                {t.name}
              </span>
              {t.status === 'error' && (
                <span className="shrink-0 text-destructive" title={t.error}>
                  failed
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {!active && (
        <div className="flex justify-end border-t border-border px-2 py-1.5">
          <button
            type="button"
            onClick={clearFinished}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden /> Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
