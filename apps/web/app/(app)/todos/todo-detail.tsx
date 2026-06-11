'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Flag, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';
import { ShareControl } from '@/components/share/share-control';
import { TodoForm, todoToForm, type Priority, type TodoPayload } from './todo-form';

export type Status = 'open' | 'done';

export type TodoRow = {
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

const PRIORITY_BADGE: Record<Priority, string> = {
  low: 'bg-muted text-muted-foreground',
  normal: 'bg-muted text-foreground',
  high: 'bg-destructive/15 text-destructive',
};

/**
 * Presentational todo detail — the client owns the todos list + all fetches and
 * passes the fresh row + callbacks, so a status toggle from the list card and an
 * edit here stay in sync. Manages only its own edit-mode flag.
 */
export function TodoDetail({
  todo,
  onToggleStatus,
  onSave,
  onDelete,
}: {
  todo: TodoRow;
  onToggleStatus: () => void;
  onSave: (payload: TodoPayload) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const done = todo.status === 'done';
  const overdue = !!todo.dueAt && new Date(todo.dueAt) < new Date() && !done;

  if (editing) {
    return (
      <div className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">Edit todo</h2>
        <TodoForm
          initial={todoToForm(todo)}
          submitLabel="Save todo"
          onSubmit={async (payload) => {
            if (await onSave(payload)) setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggleStatus}
          className={cn(
            'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors',
            done ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-muted',
          )}
          aria-label={done ? 'Mark open' : 'Mark done'}
          aria-pressed={done}
        >
          {done && <Check className="size-4" />}
        </button>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <h2 className={cn('min-w-0 text-xl font-semibold', done && 'text-muted-foreground line-through')}>
              {todo.title}
            </h2>
            <div className="flex shrink-0 items-center gap-2">
              <ShareControl nodeId={todo.id} iconOnly />
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 /> Delete
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5', PRIORITY_BADGE[todo.priority])}>
              <Flag className="size-3" /> {todo.priority}
            </span>
            <span className="text-muted-foreground">{done ? 'Done' : 'Open'}</span>
            {todo.dueAt && (
              <span className={cn(overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                · due {formatDateTime(todo.dueAt)}
                {overdue && ' · overdue'}
              </span>
            )}
          </div>

          {todo.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {todo.tags.map((t) => (
                <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {todo.body && (
        <article className="prose prose-sm dark:prose-invert max-w-none prose-accent rounded-md border border-border bg-card p-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{todo.body}</ReactMarkdown>
        </article>
      )}
      {todo.summary && <p className="text-xs italic text-muted-foreground">Indexed: {todo.summary}</p>}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{todo.title}”?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setDeleteOpen(false);
                onDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
