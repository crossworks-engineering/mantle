'use client';

import { useState } from 'react';
import { Button } from '@mantle/web-ui/ui/button';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { TagInput } from '@/components/tag-input';
import { DateTimePicker } from '@mantle/web-ui/ui/date-time-picker';

export const PRIORITIES = ['low', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type TaskFormValues = {
  title: string;
  body: string;
  priority: Priority;
  due: Date | null;
  tags: string[];
};

export type TaskPayload = {
  title: string;
  body: string;
  priority: Priority;
  dueAt: string | null;
  tags: string[];
};

export const emptyTaskForm = (): TaskFormValues => ({
  title: '',
  body: '',
  priority: 'normal',
  due: null,
  tags: [],
});

export function taskToForm(t: {
  title: string;
  body: string;
  priority: Priority;
  dueAt: string | null;
  tags: string[];
}): TaskFormValues {
  return {
    title: t.title,
    body: t.body,
    priority: t.priority,
    due: t.dueAt ? new Date(t.dueAt) : null,
    tags: t.tags,
  };
}

/**
 * Shared task editor body — used by the master-detail "create" pane and the
 * TaskDetail "edit" mode. Owns its field state; the parent POSTs/PATCHes the
 * normalized payload in `onSubmit` and switches view on success.
 */
export function TaskForm({
  initial,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: {
  initial: TaskFormValues;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (payload: TaskPayload) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<TaskFormValues>(initial);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.title.trim()) return setError('Title is required');
    await onSubmit({
      title: form.title.trim(),
      body: form.body,
      priority: form.priority,
      dueAt: form.due ? form.due.toISOString() : null,
      tags: form.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="task-title">Title</Label>
        <Input
          id="task-title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="What needs doing?"
          autoFocus
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="task-priority">Priority</Label>
          <select
            id="task-priority"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="task-due">Due (optional)</Label>
          <DateTimePicker
            id="task-due"
            value={form.due}
            onChange={(due) => setForm({ ...form, due })}
            placeholder="No due date"
            clearable
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Tags</Label>
        <TagInput
          value={form.tags}
          onChange={(tags) => setForm({ ...form, tags })}
          placeholder="Add tags…"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="task-body">Notes</Label>
        <textarea
          id="task-body"
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          rows={5}
          placeholder="Anything to remember about this task. Markdown supported."
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Plain markdown — lists, links, <code>`code`</code>, **bold** — rendered on the detail
          view.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <SubmitButton pending={submitting}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
