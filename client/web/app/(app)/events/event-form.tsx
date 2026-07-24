'use client';

import { useState } from 'react';
import { Button } from '@mantle/web-ui/ui/button';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { TagInput } from '@/components/tag-input';
import { DateTimePicker } from '@mantle/web-ui/ui/date-time-picker';
import type { RecurFreq } from '@server/lib/events';

export const REMIND_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: 'At start' },
  { value: 5, label: '5 min before' },
  { value: 15, label: '15 min before' },
  { value: 60, label: '1 hour before' },
  { value: 60 * 24, label: '1 day before' },
];

export const RECUR_PRESETS: { value: RecurFreq; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

/** Form state — datetimes as Date|null (driven by DateTimePicker), tags as string[]. */
export type EventFormValues = {
  title: string;
  body: string;
  startsAt: Date | null;
  endsAt: Date | null;
  location: string;
  remindMinutesBefore: number;
  recur: RecurFreq;
  recurUntil: Date | null;
  tags: string[];
};

/** Normalized payload for the API (ISO instants, nulls for cleared fields). */
export type EventPayload = {
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  remindMinutesBefore: number;
  recur: RecurFreq;
  recurUntil: string | null;
  tags: string[];
  timezone?: string;
};

export const emptyEventForm = (): EventFormValues => ({
  title: '',
  body: '',
  startsAt: null,
  endsAt: null,
  location: '',
  remindMinutesBefore: 0,
  recur: 'none',
  recurUntil: null,
  tags: [],
});

export function eventToForm(e: {
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  remindMinutesBefore: number;
  recur: RecurFreq;
  recurUntil: string | null;
  tags: string[];
}): EventFormValues {
  return {
    title: e.title,
    body: e.body,
    startsAt: new Date(e.startsAt),
    endsAt: e.endsAt ? new Date(e.endsAt) : null,
    location: e.location ?? '',
    remindMinutesBefore: e.remindMinutesBefore,
    recur: e.recur,
    recurUntil: e.recurUntil ? new Date(e.recurUntil) : null,
    tags: e.tags,
  };
}

/**
 * Shared event editor body — used by the master-detail "create" pane and the
 * EventDetail "edit" mode. Owns its field state; the parent POSTs/PATCHes the
 * normalized payload in `onSubmit` and switches view on success.
 */
export function EventForm({
  initial,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: {
  initial: EventFormValues;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (payload: EventPayload) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<EventFormValues>(initial);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.title.trim()) return setError('Title is required');
    if (!form.startsAt) return setError('Start time is required');
    if (form.endsAt && form.endsAt < form.startsAt) return setError('End time is before the start');
    const recurring = form.recur !== 'none';
    if (recurring && form.recurUntil && form.recurUntil < form.startsAt) {
      return setError('Repeat-until date is before the start');
    }
    await onSubmit({
      title: form.title.trim(),
      body: form.body,
      startsAt: form.startsAt.toISOString(),
      endsAt: form.endsAt ? form.endsAt.toISOString() : null,
      location: form.location.trim() || null,
      remindMinutesBefore: form.remindMinutesBefore,
      recur: form.recur,
      // Only carry an end date for a repeating event; clear it otherwise.
      recurUntil: recurring && form.recurUntil ? form.recurUntil.toISOString() : null,
      tags: form.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="event-title">Title</Label>
        <Input
          id="event-title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="e.g. Dentist appointment"
          autoFocus
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="event-starts">Starts</Label>
          <DateTimePicker
            id="event-starts"
            value={form.startsAt}
            onChange={(startsAt) => setForm({ ...form, startsAt })}
            placeholder="Pick a start"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="event-ends">Ends (optional)</Label>
          <DateTimePicker
            id="event-ends"
            value={form.endsAt}
            onChange={(endsAt) => setForm({ ...form, endsAt })}
            placeholder="Pick an end"
            clearable
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="event-remind">Remind</Label>
          <select
            id="event-remind"
            value={form.remindMinutesBefore}
            onChange={(e) => setForm({ ...form, remindMinutesBefore: Number(e.target.value) })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {REMIND_PRESETS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="event-location">Location (optional)</Label>
          <Input
            id="event-location"
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
            placeholder="Where?"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="event-repeat">Repeat</Label>
          <select
            id="event-repeat"
            value={form.recur}
            onChange={(e) => setForm({ ...form, recur: e.target.value as RecurFreq })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {RECUR_PRESETS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {form.recur !== 'none' && (
          <div className="space-y-1.5">
            <Label htmlFor="event-recur-until">Until (optional)</Label>
            <DateTimePicker
              id="event-recur-until"
              value={form.recurUntil}
              onChange={(recurUntil) => setForm({ ...form, recurUntil })}
              placeholder="Repeats forever"
              clearable
            />
          </div>
        )}
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
        <Label htmlFor="event-body">Notes</Label>
        <textarea
          id="event-body"
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          rows={5}
          placeholder="Anything to remember about this event."
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
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
