'use client';

import { Shuffle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AVATAR_STYLES, DEFAULT_AVATAR_STYLE, avatarDataUri } from '@/lib/dicebear';

export type AvatarValue = { style: string; seed: string };

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * DiceBear avatar picker — style grid + seed input + randomize, with a live
 * preview. `value` is null when no custom avatar is set (the host shows an
 * initials fallback); picking a style/seed commits a value, and "Use initials
 * instead" clears back to null.
 */
export function AvatarPicker({
  value,
  onChange,
  fallbackSeed,
  allowClear = true,
}: {
  value: AvatarValue | null;
  onChange: (v: AvatarValue | null) => void;
  /** Seed used for previews + as the initial seed when none is set. */
  fallbackSeed: string;
  allowClear?: boolean;
}) {
  const style = value?.style ?? DEFAULT_AVATAR_STYLE;
  const seed = value?.seed || fallbackSeed || 'mantle';
  const set = (patch: Partial<AvatarValue>) => onChange({ style, seed, ...patch });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarDataUri(style, seed)}
          alt="Avatar preview"
          className="size-16 shrink-0 rounded-full border bg-muted"
        />
        <div className="flex flex-1 items-center gap-2">
          <input
            value={value?.seed ?? ''}
            onChange={(e) => set({ seed: e.target.value })}
            placeholder={fallbackSeed}
            aria-label="Avatar seed"
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => set({ seed: randomSeed() })}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Shuffle className="size-3.5" aria-hidden /> Randomize
          </button>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-2 sm:grid-cols-9">
        {AVATAR_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => set({ style: s.id })}
            title={s.label}
            aria-pressed={style === s.id && value != null}
            className={cn(
              'rounded-lg border p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              style === s.id && value != null
                ? 'border-primary ring-1 ring-primary'
                : 'border-border hover:bg-accent/40',
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={avatarDataUri(s.id, seed)} alt={s.label} className="aspect-square w-full rounded" />
          </button>
        ))}
      </div>

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
  );
}
