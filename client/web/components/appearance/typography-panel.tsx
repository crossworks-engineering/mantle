'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { cn } from '@mantle/web-ui/lib/utils';
import { RadioGroup, RadioGroupCard } from '@mantle/web-ui/ui/radio-group';
import { UI_FONTS, UI_FONT_SIZES, type UiFontSize } from '@mantle/web-ui/display-fonts';
import { useFonts } from '@mantle/web-ui/font-provider';
import { FontPicker } from '@/components/appearance/font-picker';
import { LogoControl } from '@/components/appearance/logo-control';

/**
 * Type and brand identity — everything the interface is lettered with.
 *
 * FOUR equal columns: the compact controls (logo + size) stacked in the first,
 * then the three font libraries — interface, wordmark, peer name. The libraries
 * are long lists that want to run down the page, and the two small controls
 * together are about one column's worth, so nothing has to span and no column
 * ends up mostly empty.
 *
 * The interface font gets the same column treatment as the two display faces
 * rather than a wide grid of its own. It is the face you actually read all day,
 * so if anything it earns the comparison most.
 */
export function TypographyPanel() {
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
    <div className="grid items-start gap-6 md:grid-cols-2 xl:grid-cols-4">
      {/* Column 1: both compact controls, stacked. */}
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
          {/* Stacked, not three across: in a quarter-width column three cards
              side by side would crush the hint text to one word per line. */}
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
      </div>

      {/* The three libraries, one column each. `unbounded`: a capped column that
          scrolls itself inside a scrolling page is two scrollbars fighting over
          one gesture. */}
      <FontPicker
        title="Interface"
        sample="Handgloves"
        fonts={UI_FONTS}
        value={uiFont}
        onChange={setUiFont}
        unbounded
      />
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
  );
}
