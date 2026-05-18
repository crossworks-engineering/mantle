'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';

const STATUSES = ['open', 'done'] as const;
const PRIORITIES = ['low', 'normal', 'high'] as const;
type Status = (typeof STATUSES)[number];
type Priority = (typeof PRIORITIES)[number];

type TodoRow = {
  id: string;
  title: string;
  body: string;
  status: Status;
  priority: Priority;
  dueAt: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

const PRIORITY_COLOR: Record<Priority, string> = {
  low: 'text-muted-foreground',
  normal: 'text-foreground',
  high: 'text-rose-600 dark:text-rose-400',
};

function formatDue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diff = d.getTime() - now;
  const days = Math.round(diff / 86_400_000);
  if (Math.abs(days) < 1) return d.toLocaleString();
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days < 7) return `in ${days}d`;
  return d.toLocaleDateString();
}

export function TodosClient({ initialTodos }: { initialTodos: TodoRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [todos, setTodos] = useState(initialTodos);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('open');
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: '',
    body: '',
    priority: 'normal' as Priority,
    dueAt: '',
    tags: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return todos.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (q && !`${t.title} ${t.body} ${t.tags.join(' ')}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [todos, query, statusFilter, priorityFilter]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const patch = async (id: string, body: Partial<TodoRow>) => {
    const payload: Record<string, unknown> = {};
    if (body.title !== undefined) payload.title = body.title;
    if (body.body !== undefined) payload.body = body.body;
    if (body.status !== undefined) payload.status = body.status;
    if (body.priority !== undefined) payload.priority = body.priority;
    if (body.dueAt !== undefined) payload.dueAt = body.dueAt;
    if (body.tags !== undefined) payload.tags = body.tags;
    const res = await fetch(`/api/todos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? `Could not update todo (${res.status})`);
      return;
    }
    const { todo } = await res.json();
    setTodos((prev) => prev.map((t) => (t.id === id ? todo : t)));
    startTransition(() => router.refresh());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.title.trim()) {
      setError('Title is required');
      return;
    }
    const dueAt = form.dueAt ? new Date(form.dueAt).toISOString() : null;
    const res = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title.trim(),
        body: form.body,
        priority: form.priority,
        dueAt,
        tags: form.tags
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `request failed (${res.status})`);
      return;
    }
    const { todo } = await res.json();
    setTodos((prev) => [todo, ...prev]);
    setForm({ title: '', body: '', priority: 'normal', dueAt: '', tags: '' });
    setOpen(false);
    startTransition(() => router.refresh());
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this todo?')) return;
    const res = await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? `Could not delete todo (${res.status})`);
      return;
    }
    setTodos((prev) => prev.filter((t) => t.id !== id));
    startTransition(() => router.refresh());
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search todos…"
            className="pl-8"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as Status | 'all')}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">All status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value as Priority | 'all')}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-1 size-4" /> New todo
        </Button>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
          {todos.length === 0
            ? 'No todos yet. Click “New todo” or ask your assistant to add one.'
            : 'No todos match your filters.'}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {filtered.map((t) => {
            const isOpen = expanded.has(t.id);
            const overdue = t.dueAt && new Date(t.dueAt) < new Date() && t.status === 'open';
            return (
              <li key={t.id} className="group">
                <div className="flex items-start gap-3 px-3 py-2.5">
                  <button
                    onClick={() => patch(t.id, { status: t.status === 'open' ? 'done' : 'open' })}
                    className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border ${
                      t.status === 'done'
                        ? 'border-emerald-600 bg-emerald-600 text-white'
                        : 'border-input hover:bg-muted'
                    }`}
                    aria-label={t.status === 'done' ? 'Mark open' : 'Mark done'}
                  >
                    {t.status === 'done' && <Check className="size-3" />}
                  </button>
                  <button
                    onClick={() => toggleExpand(t.id)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`truncate font-medium ${
                          t.status === 'done' ? 'text-muted-foreground line-through' : ''
                        } ${PRIORITY_COLOR[t.priority]}`}
                      >
                        {t.title}
                      </span>
                      {t.priority === 'high' && (
                        <span className="shrink-0 rounded-sm bg-rose-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-rose-600 dark:text-rose-400">
                          high
                        </span>
                      )}
                      {t.dueAt && (
                        <span
                          className={`shrink-0 text-xs ${
                            overdue ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'
                          }`}
                        >
                          {formatDue(t.dueAt)}
                        </span>
                      )}
                    </div>
                    {(t.body || t.summary) && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {t.body || t.summary}
                      </p>
                    )}
                    {t.tags.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {t.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleExpand(t.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={isOpen ? 'Collapse todo' : 'Expand todo'}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(t.id)}
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label={`Delete ${t.title}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                {isOpen && (
                  <div className="space-y-2 border-t border-border bg-muted/20 px-3 py-3 text-sm">
                    {t.body && (
                      <pre className="whitespace-pre-wrap font-sans text-sm">
                        {t.body}
                      </pre>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>Priority:</span>
                      <select
                        value={t.priority}
                        onChange={(e) => patch(t.id, { priority: e.target.value as Priority })}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                      >
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                      <span>· Due:</span>
                      <input
                        type="datetime-local"
                        value={t.dueAt ? t.dueAt.slice(0, 16) : ''}
                        onChange={(e) =>
                          patch(t.id, {
                            dueAt: e.target.value
                              ? new Date(e.target.value).toISOString()
                              : null,
                          })
                        }
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                      />
                    </div>
                    {t.summary && (
                      <p className="text-xs italic text-muted-foreground">
                        Indexed: {t.summary}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New todo</DialogTitle>
            <DialogDescription>
              Title is required. Body, due date, priority, and tags are optional.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                autoFocus
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="priority">Priority</Label>
                <select
                  id="priority"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="dueAt">Due</Label>
                <Input
                  id="dueAt"
                  type="datetime-local"
                  value={form.dueAt}
                  onChange={(e) => setForm({ ...form, dueAt: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="body">Body</Label>
              <textarea
                id="body"
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={5}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input
                id="tags"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving…' : 'Save todo'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
