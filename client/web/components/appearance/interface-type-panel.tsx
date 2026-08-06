'use client';

import { cn } from '@mantle/web-ui/lib/utils';
import { RadioGroup, RadioGroupCard } from '@mantle/web-ui/ui/radio-group';
import {
  UI_FONTS,
  UI_FONT_SIZES,
  type UiFontCategory,
  type UiFontSize,
} from '@mantle/web-ui/display-fonts';
import { useFonts } from '@mantle/web-ui/font-provider';

/**
 * Interface type — the font the WHOLE UI is set in, and its scale.
 *
 * Distinct from the Brand panel's wordmark/peer-name pickers: those dress two
 * words of header, this is the face you read all day, so the previews are shown
 * at the sizes the app actually uses rather than as one big specimen line. A
 * face that looks superb at 32px and mushes at 13px is the usual failure here,
 * and a picker that only shows the 32px is complicit in it.
 *
 * Each option renders in its OWN face. That is the whole point — and it costs
 * nothing until the picker is open, because the faces are lazily fetched
 * `@font-face` declarations (see display-fonts.ts).
 */

const GROUPS: Array<{ id: UiFontCategory; label: string; hint: string }> = [
  { id: 'sans', label: 'Sans', hint: 'Built to disappear — read all day' },
  { id: 'mono', label: 'Mono', hint: 'Fixed width, everywhere' },
  { id: 'character', label: 'Character', hint: 'Opinionated. Live in it a while first' },
];

function SizeControl() {
  const { fontSize, setFontSize } = useFonts();
  return (
    <section className="space-y-2">
      <h2
        id="ui-size-heading"
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      >
        Interface size
      </h2>
      <p className="max-w-prose text-xs text-muted-foreground">
        Scales the whole interface, not just the text — spacing, controls and the header move with
        it.
      </p>
      <RadioGroup
        value={fontSize}
        onValueChange={(v) => setFontSize(v as UiFontSize)}
        aria-labelledby="ui-size-heading"
        className="grid-cols-3 gap-2 sm:max-w-lg"
      >
        {UI_FONT_SIZES.map((s) => (
          <RadioGroupCard
            key={s.id}
            value={s.id}
            className={cn(
              'flex flex-col items-start gap-1 border-border p-2.5 text-left',
              'hover:bg-accent/40',
              'data-[state=checked]:border-primary data-[state=checked]:bg-accent/50 data-[state=checked]:ring-1 data-[state=checked]:ring-primary',
            )}
          >
            <span className="text-sm font-medium text-foreground">{s.label}</span>
            <span className="text-xs leading-snug text-muted-foreground">{s.hint}</span>
          </RadioGroupCard>
        ))}
      </RadioGroup>
    </section>
  );
}

export function InterfaceTypePanel() {
  const { uiFont, setUiFont } = useFonts();

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2
          id="ui-font-heading"
          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Interface font
        </h2>
        <p className="max-w-prose text-xs text-muted-foreground">
          The face the entire app is set in. Each option is shown in itself, at the sizes the UI
          actually uses.
        </p>

        <RadioGroup
          value={uiFont}
          onValueChange={setUiFont}
          aria-labelledby="ui-font-heading"
          className="gap-5"
        >
          {GROUPS.map((g) => {
            const inGroup = UI_FONTS.filter((f) => f.category === g.id);
            if (inGroup.length === 0) return null;
            return (
              <div key={g.id} className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {g.label} <span className="font-normal opacity-70">— {g.hint}</span>
                </h3>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {inGroup.map((f) => {
                    // `sans-serif` here is only the generic fallback while the
                    // face streams in; the real family is the @font-face name.
                    const family = f.family ? `"${f.family}", ${f.fallback}` : undefined;
                    return (
                      <RadioGroupCard
                        key={f.key}
                        value={f.key}
                        className={cn(
                          'flex flex-col items-start gap-1 border-border p-3 text-left',
                          'hover:bg-accent/40',
                          'data-[state=checked]:border-primary data-[state=checked]:ring-1 data-[state=checked]:ring-primary',
                        )}
                      >
                        <span
                          className="block w-full truncate text-lg leading-tight text-foreground"
                          style={{ fontFamily: family }}
                        >
                          {f.label}
                        </span>
                        {/* The sizes the app is actually built from: body text
                            and a 600-weight label. A variable face that has not
                            declared its weight range gives itself away here. */}
                        <span
                          className="block w-full truncate text-sm text-muted-foreground"
                          style={{ fontFamily: family }}
                        >
                          Handgloves 0123 · <span className="font-semibold">Semibold</span>
                        </span>
                      </RadioGroupCard>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </RadioGroup>
      </section>

      <SizeControl />
    </div>
  );
}
