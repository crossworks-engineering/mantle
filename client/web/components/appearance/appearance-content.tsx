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
 * The FONTS section opens the page, full-width, as one 2×2 card grid (reading
 * faces left, header faces right — the order lives in FontRows). One section
 * rather than a split across columns, so the four cards stay height-aligned
 * with a single heading; the font library itself lives in a dialog since the
 * faces became real text families that want previewing at reading size. The
 * grid below it pairs the logo with the avatar controls.
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
      {/* First: one Fonts section, the four cards as a 2×2 grid — typography is
          the setting reached for most, so it opens the page. */}
      <FontRows />

      <div className="grid items-start gap-6 md:grid-cols-2">
        {/* Column 1: the logo. */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Logo
          </h2>
          <LogoControl />
        </section>

        {/* Column 2: the avatar controls (their 50-card gallery is below). */}
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
