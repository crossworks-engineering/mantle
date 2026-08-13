'use client';

import { FontRows } from '@/components/appearance/font-rows';
import { LogoControl } from '@/components/appearance/logo-control';
import { AvatarStyleControls, AvatarStyleList } from '@/components/appearance/avatar-style-gallery';
import { BackgroundGallery } from '@/components/appearance/background-gallery';
import { ColorPalette } from '@/components/theme-preview/color-palette';

/**
 * The Appearance screen's content — everything to the right of the mode/theme
 * sidebar. ALL of this screen's layout lives here on purpose: it is the one part
 * of the app that gets re-arranged by eye, and chasing a column change across
 * three components is how the arrangement drifts out of step with itself.
 *
 * TWO columns now, not three. The font library used to occupy two of them as
 * scrolling lists of every face; it lives in a dialog since the faces became
 * real text families that want previewing at reading size. What is left is the
 * brand column (logo, then the four font rows, each its own preview) beside the
 * avatar controls.
 *
 * The avatar STYLE LIST is the exception and sits full-width below the grid: 50
 * cards of four live previews each is the one thing here that needs the width.
 *
 * The colour palette sits full-width beneath: it is a wide token table, and it
 * is a readout rather than a setting. It stays because its test discovers the
 * shipped token list and demands the palette list every one — drop it and a new
 * semantic role can ship with nowhere to audition it.
 */
export function AppearanceContent() {
  return (
    <div className="space-y-8">
      <div className="grid items-start gap-6 md:grid-cols-2">
        {/* Column 1: the brand — what the product is called and how it is set. */}
        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Logo
            </h2>
            <LogoControl />
          </section>

          <FontRows />
        </div>

        {/* Column 2: the avatar controls. Its 50-card gallery is below. */}
        <AvatarStyleControls />
      </div>

      {/* Full-width: 50 style cards, each carrying four live previews, is the one
          thing on this screen that genuinely needs the room. Its heading and the
          tint live up in the controls column with the other settings. */}
      <AvatarStyleList />

      {/* Full-width for the same reason: one scrollable row per area, and the
          rows only read as a comparison at their natural width. */}
      <BackgroundGallery />

      <ColorPalette />
    </div>
  );
}
