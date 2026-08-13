'use client';

import Link from 'next/link';
import { cn } from '@mantle/web-ui/lib/utils';
import { AreaBackdrop } from '@mantle/web-ui/area-backdrop';
import { BrandLogo } from './brand-logo';

/**
 * Identity block at the head of the rail: the wordmark (or the uploaded brand
 * logo) on the first line, this brain's peer name on the second.
 *
 * This is the heir to the old fixed header, which is why it — and not only the
 * mobile bar — carries the `header` area backdrop. The Appearance setting keeps
 * decorating the same thing it always decorated, now that the thing has moved
 * into the rail; see @mantle/web-ui/backgrounds.
 *
 * BOTH LINES CLIP ON THE WIDTH ONLY (`overflow-x-clip` bounded by the column,
 * `overflow-y-visible`, with `-mx-2`/`px-2` giving the sides room). The
 * selectable faces are display faces whose swashes and descenders leave the em
 * box, and a plain `truncate` clips both axes — it shaves the ink off the top
 * and bottom of the letterforms rather than ending the line. Carried over from
 * the header verbatim; it was learned the hard way.
 *
 * Face AND size come from the `.wordmark` / `.peer-name` classes (Settings →
 * Appearance → Fonts), never from a local `text-*` step: each class pairs its
 * font var with its own size multiplier so the two halves of one choice cannot
 * be applied separately. Overriding the size here would silently defeat the
 * owner's size setting for these two lines only.
 *
 * Collapsed rail: the logo shrinks to a square, and a brain with no uploaded
 * logo gets a mark built from the first character of its name — in the same
 * wordmark face, so the icon rail still carries the brand. A 3.5rem column has
 * no room for a wordmark, and shrinking one until it fits reads as a bug.
 */
export function BrandBlock({
  siteName,
  peerName,
  logoVersion,
  logoDarkVersion,
  inDrawer = false,
  onNavigate,
}: {
  /** Custom wordmark from prefs; null ⇒ the "mantle" default. */
  siteName?: string | null;
  /** This brain's peer name, the second line; null ⇒ the line is not rendered. */
  peerName?: string | null;
  /** Brand logo version; set ⇒ an image replaces the wordmark TEXT. */
  logoVersion?: string | null;
  /** Optional dark-mode variant, shown while `.dark` is active; falls back to
   *  the base logo, then to the wordmark. */
  logoDarkVersion?: string | null;
  /** Rendered inside the mobile Sheet, which floats its own close button over
   *  the top-right corner. The identity lines reserve room for it there; in the
   *  aside there is nothing to dodge and the full column width is usable. */
  inDrawer?: boolean;
  onNavigate?: () => void;
}) {
  const name = siteName || 'mantle';
  // Array.from, not charAt: a name starting with an emoji or any astral-plane
  // character would otherwise be cut mid-surrogate-pair and render as a tofu.
  const mark = Array.from(name.trim())[0] ?? 'm';

  return (
    <div
      className={cn(
        // `isolate` is what makes the backdrop's `-z-10` mean what it says.
        // The old header owned a stacking context by being `fixed z-40`; this
        // block is a plain `relative` child of the aside, and without its own
        // context the negative-z artwork would escape to the ASIDE's context —
        // under this block's gradient and under the menu backdrop.
        'relative isolate shrink-0 border-b border-sidebar-border bg-gradient-to-b from-primary/[0.07] to-transparent px-3 py-3 group-data-[nav-collapsed=true]/shell:px-2',
        inDrawer && 'pr-12',
      )}
    >
      {/* `-z-10` paints the generated artwork above this block's own gradient
          but below its text. Renders nothing when the area is switched off. */}
      <AreaBackdrop area="header" className="-z-10" />

      <Link
        href="/"
        onClick={onNavigate}
        aria-label={`${name} home`}
        title={name}
        className="flex min-w-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[nav-collapsed=true]/shell:justify-center"
      >
        <BrandLogo
          name={name}
          logoVersion={logoVersion}
          logoDarkVersion={logoDarkVersion}
          imgClassName="h-9 w-auto max-w-full object-contain object-left group-data-[nav-collapsed=true]/shell:size-8 group-data-[nav-collapsed=true]/shell:object-center"
          renderWordmark={(visibility) => (
            <Wordmark name={name} mark={mark} className={visibility} />
          )}
        />
      </Link>

      {peerName && (
        <p
          // The peer name sits under the wordmark as a subtitle, in the
          // user-selectable page-title face (Settings → Appearance → Fonts;
          // unset ⇒ inherits the UI sans). Same width-only clipping as above.
          className="peer-name -mx-2 mt-1 max-w-full overflow-x-clip overflow-y-visible whitespace-nowrap px-2 font-semibold leading-snug tracking-tight text-muted-foreground group-data-[nav-collapsed=true]/shell:hidden"
          title={peerName}
        >
          {peerName}
        </p>
      )}
    </div>
  );
}

/**
 * The text wordmark, in the user-selectable wordmark face, plus the
 * single-character mark that stands in for it in the collapsed rail. Both are
 * rendered; the shell's collapse state picks one, so no width measurement or JS
 * is involved in the swap.
 */
function Wordmark({ name, mark, className }: { name: string; mark: string; className?: string }) {
  return (
    <>
      <span
        className={cn(
          'wordmark -mx-2 max-w-full overflow-x-clip overflow-y-visible whitespace-nowrap px-2 py-1 leading-none text-primary-ink group-data-[nav-collapsed=true]/shell:hidden',
          className,
        )}
      >
        {name}
      </span>
      <span
        aria-hidden
        className={cn(
          'wordmark hidden size-9 shrink-0 select-none items-center justify-center rounded-lg bg-primary leading-none text-primary-foreground group-data-[nav-collapsed=true]/shell:flex',
          className,
        )}
      >
        {mark}
      </span>
    </>
  );
}
