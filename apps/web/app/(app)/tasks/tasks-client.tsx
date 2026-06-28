'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ListTodo, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ListPager } from '@/components/layout/list-pager';
import { useListNav } from '@/lib/use-list-nav';
import { syncSelectionParam } from '@/lib/url-sync';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { TaskForm, emptyTaskForm, PRIORITIES, type Priority, type TaskPayload } from './task-form';
import { TaskDetail, type Status, type TaskRow } from './task-detail';

const STATUSES = ['open', 'done'] as const;
type Selection = { mode: 'create' } | { mode: 'view'; id: string } | null;

function dueLabel(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const days = Math.round(diff / 86_400_000);
  if (Math.abs(days) < 1) return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days < 7) return `in ${days}d`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

type TasksListResponse = { tasks: TaskRow[]; total: number; page: number; pageSize: number };

export function TasksClient() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { pending: navPending, go } = useListNav();
  const toast = useToast();

  // URL is the source of truth (matches the old SSR page). Status defaults to
  // 'open' here (the GET defaults to 'all'), so send it explicitly.
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const status = (searchParams.get('status')?.trim() || 'open') as Status | 'all';
  const priority = (searchParams.get('priority')?.trim() || 'all') as Priority | 'all';
  const urlSelected = searchParams.get('selected')?.trim() || null;

  const listQuery = useQuery({
    queryKey: ['tasks', { q: query, status, priority, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      qs.set('status', status);
      if (priority !== 'all') qs.set('priority', priority);
      if (page > 1) qs.set('page', String(page));
      return apiFetch<TasksListResponse>(`/api/tasks?${qs.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  // A deep-linked task (`?selected=`) may sit outside the current slice or be
  // filtered out — fetch it directly so the detail pane can still open it.
  const selectedTaskQuery = useQuery({
    queryKey: ['tasks', urlSelected],
    queryFn: () => apiFetch<{ task: TaskRow }>(`/api/tasks/${urlSelected}`).then((r) => r.task),
    enabled: !!urlSelected && !(listQuery.data?.tasks ?? []).some((t) => t.id === urlSelected),
  });

  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.pageSize ?? 50;

  // Local working copy of the list, so mutations can update optimistically. Seeded
  // from the query (+ a deep-linked task pinned at the top); the seed effect below
  // reconciles it whenever the server data changes (incl. after a mutation's invalidate).
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  useEffect(() => {
    const base = listQuery.data?.tasks ?? [];
    const extra =
      selectedTaskQuery.data && !base.some((t) => t.id === selectedTaskQuery.data!.id)
        ? [selectedTaskQuery.data]
        : [];
    setTasks([...extra, ...base]);
  }, [listQuery.data, selectedTaskQuery.data]);

  const [searchInput, setSearchInput] = useState(query);
  const [pending, startTransition] = useTransition();
  // null = "not yet defaulted"; the effect below picks the first task / create
  // mode once the list loads, unless the URL deep-links a selection.
  const [sel, setSel] = useState<Selection>(urlSelected ? { mode: 'view', id: urlSelected } : null);
  useEffect(() => {
    if (sel !== null) return;
    setSel(tasks[0] ? { mode: 'view', id: tasks[0].id } : { mode: 'create' });
  }, [tasks, sel]);

  // Reflect the selected task in the URL (?selected=) as the user clicks
  // around — copy-/share-/bookmark-able, and aligned with the `/n/<id>`
  // permalink. `replaceState` (no fetch, no back-stack entry); skip the first
  // run so a fresh load / deep link isn't rewritten before any interaction.
  const didSyncMount = useRef(false);
  useEffect(() => {
    if (!didSyncMount.current) {
      didSyncMount.current = true;
      return;
    }
    syncSelectionParam('selected', sel?.mode === 'view' ? sel.id : null);
  }, [sel]);

  // Debounced search → URL (?q=); resets to page 1.
  useEffect(() => {
    const h = setTimeout(() => {
      if (searchInput.trim() !== query) go({ q: searchInput.trim() || null, page: null });
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const filtering = !!query || status !== 'open' || priority !== 'all';
  const selected = sel?.mode === 'view' ? (tasks.find((t) => t.id === sel.id) ?? null) : null;

  const createTask = async (payload: TaskPayload) => {
    let task: TaskRow;
    try {
      ({ task } = await apiSend<{ task: TaskRow }>('/api/tasks', 'POST', payload));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not save task');
      return;
    }
    setTasks((prev) => [task, ...prev]);
    setSel({ mode: 'view', id: task.id });
    toast.success(`Added “${task.title}”`);
    startTransition(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    });
  };

  const saveTask = async (id: string, payload: TaskPayload): Promise<boolean> => {
    let task: TaskRow;
    try {
      ({ task } = await apiSend<{ task: TaskRow }>(`/api/tasks/${id}`, 'PATCH', payload));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return false; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not update task');
      return false;
    }
    setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    startTransition(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    });
    return true;
  };

  const toggleStatus = async (t: TaskRow) => {
    const next: Status = t.status === 'open' ? 'done' : 'open';
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: next } : x))); // optimistic
    let task: TaskRow;
    try {
      ({ task } = await apiSend<{ task: TaskRow }>(`/api/tasks/${t.id}`, 'PATCH', { status: next }));
    } catch (e) {
      setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: t.status } : x))); // revert
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not update task');
      return;
    }
    setTasks((prev) => prev.map((x) => (x.id === t.id ? task : x)));
    startTransition(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    });
  };

  const removeTask = async (id: string) => {
    try {
      await apiSend(`/api/tasks/${id}`, 'DELETE');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not delete task');
      return;
    }
    toast.success('Task deleted');
    setTasks((prev) => {
      const nextList = prev.filter((t) => t.id !== id);
      setSel(nextList[0] ? { mode: 'view', id: nextList[0].id } : { mode: 'create' });
      return nextList;
    });
    startTransition(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    });
  };

  if (listQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (listQuery.isError && !listQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          {listQuery.error instanceof Error ? listQuery.error.message : 'Failed to load tasks.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: task list ──────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Tasks</h2>
          <Button type="button" size="sm" onClick={() => setSel({ mode: 'create' })}>
            <Plus /> New
          </Button>
        </div>
        <div className="space-y-2 border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search tasks…"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex gap-2">
            <select
              value={status}
              onChange={(e) => go({ status: e.target.value, page: null })}
              className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              aria-label="Filter by status"
            >
              <option value="all">All status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={priority}
              onChange={(e) => go({ priority: e.target.value === 'all' ? null : e.target.value, page: null })}
              className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              aria-label="Filter by priority"
            >
              <option value="all">All priorities</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {tasks.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              {filtering ? (
                'No tasks match your search or filters.'
              ) : (
                <>
                  No tasks yet. Click <strong>New</strong> to add one.
                </>
              )}
            </p>
          ) : (
            tasks.map((t) => {
              const isSel = sel?.mode === 'view' && sel.id === t.id;
              const done = t.status === 'done';
              const overdue = !!t.dueAt && new Date(t.dueAt) < new Date() && !done;
              return (
                <div
                  key={t.id}
                  className={cn(
                    'flex items-start gap-2.5 rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 transition-colors',
                    isSel ? 'border-l-primary' : 'hover:bg-muted/50',
                    t.priority === 'high' && !isSel && 'border-l-destructive',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleStatus(t)}
                    className={cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
                      done ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-muted',
                    )}
                    aria-label={done ? 'Mark open' : 'Mark done'}
                    aria-pressed={done}
                  >
                    {done && <Check className="size-3" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSel({ mode: 'view', id: t.id })}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className={cn('truncate text-sm font-medium', done && 'text-muted-foreground line-through')}>
                        {t.title}
                      </span>
                      {t.dueAt && (
                        <span
                          className={cn(
                            'ml-auto shrink-0 text-xs tabular-nums',
                            overdue ? 'font-medium text-destructive' : 'text-muted-foreground',
                          )}
                        >
                          {dueLabel(t.dueAt)}
                        </span>
                      )}
                    </div>
                    {(t.body || t.summary) && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{t.body || t.summary}</p>
                    )}
                    {t.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {t.tags.map((tag) => (
                          <span key={tag} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <ListPager
          page={page}
          total={total}
          pageSize={pageSize}
          pending={navPending}
          onGo={(p) => go({ page: p > 1 ? p : null })}
        />
      </div>

      {/* ── Right: create | detail | empty ───────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {sel?.mode === 'create' ? (
          <div className="space-y-4 p-6">
            <div className="flex items-center gap-2">
              <ListTodo className="size-5 text-primary" aria-hidden />
              <h2 className="text-lg font-semibold">New task</h2>
            </div>
            <TaskForm
              initial={emptyTaskForm()}
              submitLabel="Save task"
              submitting={pending}
              onSubmit={createTask}
              onCancel={() =>
                setSel(tasks[0] ? { mode: 'view', id: tasks[0].id } : { mode: 'create' })
              }
            />
          </div>
        ) : selected ? (
          <TaskDetail
            key={selected.id}
            task={selected}
            onToggleStatus={() => toggleStatus(selected)}
            onSave={(payload) => saveTask(selected.id, payload)}
            onDelete={() => removeTask(selected.id)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a task, or add a new one.
          </div>
        )}
      </div>
    </div>
  );
}
