'use client';

import { Shuffle, X } from 'lucide-react';
import { randomAvatarSeed } from '@mantle/web-ui/avatar';
import { GeneratedAvatar } from '@mantle/web-ui/generated-avatar';

export type AvatarValue = { seed: string };

/**
 * Avatar picker — a live preview you reroll with Randomize.
 *
 * SEED ONLY. The style is the brain's, chosen once in Settings → Appearance,
 * and every avatar in the brain is drawn in it; what this picks is the seed,
 * which is the thing that makes THIS avatar yours. Rerolling used to change
 * the style too, which is how a brain ended up showing six unrelated styles at
 * once.
 *
 * `value` is null when no custom avatar is set (the host shows an initials
 * fallback); Randomize commits one, and "Use initials instead" clears back.
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
  const seed = value?.seed || fallbackSeed || 'mantle';

  return (
    <div className="flex items-center gap-4">
      <GeneratedAvatar seed={seed} size={64} className="border bg-muted" />
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={() => onChange({ seed: randomAvatarSeed() })}
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
