'use client';

import { Shuffle, X } from 'lucide-react';
import { DEFAULT_AVATAR_STYLE, avatarUrl, randomSeed, randomStyle } from '@/lib/avatar';

export type AvatarValue = { style: string; seed: string };

/**
 * Avatar picker — a live preview you reroll with Randomize (random style +
 * seed each click). `value` is null when no custom avatar is set (the host
 * shows an initials fallback); Randomize commits a value, and "Use initials
 * instead" clears back to null. The preview loads from the cacheable
 * /api/avatar endpoint, so no avatar-generator code ships to the client.
 */
export function AvatarPicker({
  value,
  onChange,
  fallbackSeed,
  allowClear = true,
}: {
  value: AvatarValue | null;
  onChange: (v: AvatarValue | null) => void;
  /** Seed used for the preview when no avatar is set yet. */
  fallbackSeed: string;
  allowClear?: boolean;
}) {
  const style = value?.style ?? DEFAULT_AVATAR_STYLE;
  const seed = value?.seed || fallbackSeed || 'mantle';

  return (
    <div className="flex items-center gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={avatarUrl(style, seed)}
        alt="Avatar preview"
        className="size-16 shrink-0 rounded-full border bg-muted"
      />
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={() => onChange({ style: randomStyle(), seed: randomSeed() })}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Shuffle className="size-3.5" aria-hidden /> Randomize
        </button>
        {allowClear && value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" aria-hidden /> Use initials instead
          </button>
        )}
      </div>
    </div>
  );
}
