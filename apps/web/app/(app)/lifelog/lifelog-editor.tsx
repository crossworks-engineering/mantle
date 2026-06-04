'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { MOODS, CATEGORIES } from '@mantle/content/lifelog-options';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { TagInput } from '@/components/tag-input';
import { useToast } from '@/components/ui/toast';

export type LifelogRow = {
  id: string;
  title: string;
  body: string;
  mood: string | null;
  category: string | null;
  entryDate: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

// Radix Select forbids an empty-string item value, so "no selection" rides a
// sentinel that maps to '' on save (clears the field).
const NONE = '__none__';

/**
 * Life Log entry editor — a small, plain-text paragraph plus mood + category.
 * No markdown editor by design: entries are short and atomic so they chunk
 * cleanly into the identity context. Handles create (`entry=null` → POST) and
 * edit (PATCH). ⌘/Ctrl+S saves, Esc cancels. Reports `dirty` up so the host
 * can guard against discarding unsaved changes.
 */
export function LifelogEditor({
  entry,
  onSaved,
  onCancel,
  onDirtyChange,
}: {
  entry: LifelogRow | null;
  onSaved: (saved: LifelogRow) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const creating = entry === null;
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [mood, setMood] = useState(entry?.mood ?? '');
  const [category, setCategory] = useState(entry?.category ?? '');
  const [entryDate, setEntryDate] = useState<Date | null>(
    entry?.entryDate ? new Date(entry.entryDate) : null,
  );
  const [tags, setTags] = useState<string[]>(entry?.tags ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(entry?.title ?? '');
    setBody(entry?.body ?? '');
    setMood(entry?.mood ?? '');
    setCategory(entry?.category ?? '');
    setEntryDate(entry?.entryDate ? new Date(entry.entryDate) : null);
    setTags(entry?.tags ?? []);
  }, [entry?.id]);

  const initialDate = entry?.entryDate ? new Date(entry.entryDate).getTime() : null;
  const dirty = creating
    ? body.trim() !== '' || mood !== '' || category !== '' || tags.length > 0
    : title !== (entry?.title ?? '') ||
      body !== (entry?.body ?? '') ||
      mood !== (entry?.mood ?? '') ||
      category !== (entry?.category ?? '') ||
      (entryDate?.getTime() ?? null) !== initialDate ||
      tags.join(' ') !== (entry?.tags ?? []).join(' ');

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  async function save() {
    if (!body.trim()) {
      toast.error('Write something first');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        body: body.trim(),
        title: title.trim() || undefined,
        mood,
        category,
        entryDate: entryDate ? entryDate.toISOString() : '',
      };
      const res = await fetch(creating ? '/api/lifelog' : `/api/lifelog/${entry!.id}`, {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, tags }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? `Save failed (${res.status})`);
        return;
      }
      const { lifelog: saved } = (await res.json()) as { lifelog: LifelogRow };
      toast.success(creating ? 'Life log saved' : 'Saved');
      onSaved(saved);
    } finally {
      setSaving(false);
    }
  }

  // ⌘/Ctrl+S save · Esc cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body, mood, category, entryDate, tags, creating]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex h-full min-h-0 flex-col"
    >
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          aria-label="Life log title"
          className="h-9 flex-1 border-0 bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
        />
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          <X /> Cancel
        </Button>
        <SubmitButton pending={saving} size="sm">
          {creating ? 'Save life log' : 'Save life log'}
        </SubmitButton>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-thin px-4 py-4">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="A short, honest note — who you are, what you’re doing, how you feel…"
          autoFocus
          className="min-h-[10rem] resize-y text-base leading-relaxed"
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="lifelog-mood">Mood</Label>
            <Select value={mood || NONE} onValueChange={(v) => setMood(v === NONE ? '' : v)}>
              <SelectTrigger id="lifelog-mood">
                <SelectValue placeholder="How did it feel?" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>— None —</SelectItem>
                {MOODS.map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {m.emoji} {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lifelog-category">Area of life</Label>
            <Select
              value={category || NONE}
              onValueChange={(v) => setCategory(v === NONE ? '' : v)}
            >
              <SelectTrigger id="lifelog-category">
                <SelectValue placeholder="What is this about?" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>— None —</SelectItem>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="lifelog-date">When (optional)</Label>
          <DateTimePicker
            id="lifelog-date"
            value={entryDate}
            onChange={setEntryDate}
            placeholder="Defaults to now"
            clearable
          />
        </div>

        <div className="space-y-1.5">
          <Label>Tags</Label>
          <TagInput value={tags} onChange={setTags} placeholder="Add tags — comma or Enter…" />
        </div>
      </div>
    </form>
  );
}
