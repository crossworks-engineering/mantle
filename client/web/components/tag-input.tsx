'use client';

import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { tagColorClass } from '@mantle/web-ui/tag-pill';

/**
 * Tag editor: type a tag and commit it to a colored pill with comma or
 * Enter; Backspace on an empty field removes the last pill; pasting a
 * comma-separated string adds them all. Controlled via `value`/`onChange`
 * (an array of normalized lowercase tags).
 */
export function TagInput({
  value,
  onChange,
  placeholder,
  id,
  max = 20,
  maxLength = 40,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  id?: string;
  max?: number;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (raw: string) => {
    const t = raw.trim().toLowerCase().slice(0, maxLength);
    setDraft('');
    if (!t || value.includes(t) || value.length >= max) return;
    onChange([...value, t]);
  };

  const removeTag = (t: string) => onChange(value.filter((x) => x !== t));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ',' || e.key === 'Enter') {
      e.preventDefault();
      addTag(draft);
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      removeTag(value[value.length - 1]!);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text.includes(',')) return;
    e.preventDefault();
    for (const part of text.split(',')) addTag(part);
  };

  return (
    <div
      className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((t) => (
        <span
          key={t}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
            tagColorClass(t),
          )}
        >
          {t}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removeTag(t);
            }}
            className="-mr-0.5 rounded-sm opacity-60 transition-opacity hover:opacity-100"
            aria-label={`Remove ${t}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => addTag(draft)}
        placeholder={value.length === 0 ? placeholder : ''}
        className="min-w-[8ch] flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
