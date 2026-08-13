'use client';

import { cn } from '@mantle/web-ui/lib/utils';

/**
 * The Jackdaw brand art, for the surfaces that stand in for a text wordmark on
 * a brain with no site name of its own (the rail's brand block, the mobile
 * bar). The moment an owner names their brain the name is theirs, and the text
 * wordmark returns — these render only in the unnamed case.
 *
 * Written ONCE, for the same reason `BrandLogo` is: its own doc records that
 * the mobile bar's hand-copied version of that cascade dropped a branch and
 * shipped an empty brand link. This is the same shape of hazard — a light/dark
 * pair where the second img is easy to omit or mis-class — so both surfaces
 * call these rather than repeating the pair.
 *
 * WHY THE `contents` WRAPPER. Callers need to hide the whole mark (the rail
 * collapses; `BrandLogo` passes `dark:hidden` when the mark only stands in for
 * a missing LIGHT logo). That visibility class has to land ABOVE the light/dark
 * swap: put `dark:hidden` on the imgs themselves and it collides with the dark
 * img's own `dark:block`, leaving the winner to utility order in the generated
 * sheet. `contents` keeps the wrapper out of layout, so the imgs stay direct
 * flex children of the link, while `display:none` on it still takes the whole
 * subtree with it.
 */
function Pair({
  src,
  base,
  className,
  visibility,
  alt,
  width,
  height,
  darkWidth,
}: {
  src: (variant: 'light' | 'dark') => string;
  base: string;
  className?: string;
  visibility?: string;
  alt: string;
  width: number;
  height: number;
  darkWidth?: number;
}) {
  return (
    <span className={cn('contents', visibility)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src('light')}
        alt={alt}
        aria-hidden={alt === '' || undefined}
        width={width}
        height={height}
        className={cn(base, className, 'dark:hidden')}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src('dark')}
        alt={alt}
        aria-hidden={alt === '' || undefined}
        width={darkWidth ?? width}
        height={height}
        className={cn(base, className, 'hidden dark:block')}
      />
    </span>
  );
}

/** Badge and wordmark on ONE line — the shape that fits a bar or a rail. */
export function JackdawRow({
  className,
  visibility,
}: {
  /** Sizing for both imgs; supply the height (e.g. `h-9`). */
  className?: string;
  /** Applied to the wrapper, above the light/dark swap. */
  visibility?: string;
}) {
  return (
    <Pair
      src={(v) => `/brand/jackdaw-row-${v}.png`}
      base="w-auto object-contain object-left"
      className={className}
      visibility={visibility}
      alt="Jackdaw"
      width={129}
      darkWidth={127}
      height={36}
    />
  );
}

/**
 * The badge alone, square. For columns too narrow for a lockup — a 3.5rem rail
 * has no room for one, and shrinking a lockup until it fits reads as a bug.
 * Decorative: it only ever appears beside an `aria-label`ed link.
 */
export function JackdawBadge({
  className,
  visibility,
}: {
  className?: string;
  visibility?: string;
}) {
  return (
    <Pair
      src={(v) => `/brand/jackdaw-badge-${v}.png`}
      base="object-contain"
      className={className}
      visibility={visibility}
      alt=""
      width={32}
      height={32}
    />
  );
}
