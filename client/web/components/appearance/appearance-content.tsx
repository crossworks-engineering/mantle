'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { cn } from '@mantle/web-ui/lib/utils';
import { RadioGroup, RadioGroupCard } from '@mantle/web-ui/ui/radio-group';
import { UI_FONTS, UI_FONT_SIZES, type UiFontSize } from '@mantle/web-ui/display-fonts';
import { useFonts } from '@mantle/web-ui/font-provider';
import { FontPicker } from '@/components/appearance/font-picker';
import { LogoControl } from '@/components/appearance/logo-control';
import { AvatarStyleGallery } from '@/components/appearance/avatar-style-gallery';
import { ColorPalette } from '@/components/theme-preview/color-palette';

/**
 * The Appearance screen's content — everything to the right of the mode/theme
 * sidebar. ALL of this screen's layout lives here on purpose: it is the one part
 * of the app that gets re-arranged by eye, and chasing a column change across
 * three components is how the arrangement drifts out of step with itself.
 *
 * THREE equal columns. The first stacks everything that governs the INTERFACE —
 * logo, size, the interface font, the avatar style — while the two display faces
 * take a column each. Grouping by what a control does beats giving every list
 * its own column.
 *
 * The colour palette sits full-width beneath: it is a wide token table, and it
 * is a readout rather than a setting. It stays because its test discovers the
 * shipped token list and demands the palette list every one — drop it and a new
 * semantic role can ship with nowhere to audition it.
 */
export function AppearanceContent() {
  const {
    logoFont,
    titleFont,
    uiFont,
    fontSize,
    setLogoFont,
    setTitleFont,
    setUiFont,
    setFontSize,
  } = useFonts();
  const shell = useQuery({
    queryKey: ['shell'],
    queryFn: () => apiFetch<{ siteName: string | null; peerName: string | null }>('/api/shell'),
  });
  const wordmark = shell.data?.siteName || 'mantle';
  const peer = shell.data?.peerName || 'Peer name';

  return (
    <div className="space-y-8">
      <div className="grid items-start gap-6 md:grid-cols-2 xl:grid-cols-3">
        {/* Column 1: everything that governs the interface, stacked. */}
        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Logo
            </h2>
            <LogoControl />
          </section>

          <section className="space-y-2">
            <h2
              id="ui-size-heading"
              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Interface size
            </h2>
            {/* Stacked, not three across: in a one-third column three cards side
              by side would crush each hint to one word per line. */}
            <RadioGroup
              value={fontSize}
              onValueChange={(v) => setFontSize(v as UiFontSize)}
              aria-labelledby="ui-size-heading"
              className="gap-2"
            >
              {UI_FONT_SIZES.map((s) => (
                <RadioGroupCard
                  key={s.id}
                  value={s.id}
                  className={cn(
                    'flex flex-col items-start gap-0.5 border-border p-2 text-left',
                    'hover:bg-accent/40',
                    'data-[state=checked]:border-primary data-[state=checked]:bg-accent/50 data-[state=checked]:ring-1 data-[state=checked]:ring-primary',
                  )}
                >
                  <span className="text-sm font-medium text-foreground">{s.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{s.hint}</span>
                </RadioGroupCard>
              ))}
            </RadioGroup>
            <p className="text-xs text-muted-foreground">
              Scales the whole interface — spacing, controls and the header move with the text.
            </p>
          </section>

          {/* `unbounded` on every picker: a capped column that scrolls itself
            inside a scrolling page is two scrollbars fighting over one
            gesture. */}
          <FontPicker
            title="Interface font"
            sample="Handgloves"
            fonts={UI_FONTS}
            value={uiFont}
            onChange={setUiFont}
            unbounded
          />

          <AvatarStyleGallery />
        </div>

        <FontPicker
          title="Wordmark"
          sample={wordmark}
          value={logoFont}
          onChange={setLogoFont}
          unbounded
        />
        <FontPicker
          title="Peer name"
          sample={peer}
          value={titleFont}
          onChange={setTitleFont}
          unbounded
        />
      </div>

      <ColorPalette />
    </div>
  );
}
