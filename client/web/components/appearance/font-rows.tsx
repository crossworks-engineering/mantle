'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { cn } from '@mantle/web-ui/lib/utils';
import { FontDialog } from '@mantle/web-ui/font-dialog';
import { useFonts, type FontSlot } from '@mantle/web-ui/font-provider';
import { FONT_SIZES, fontByKey, fontFamilyValue } from '@mantle/web-ui/display-fonts';

/**
 * The four typography rows on Settings → Appearance.
 *
 * Each row is a button showing the slot's CURRENT face, set in that face, with
 * its size beside it; clicking opens the shared dialog. The library used to be
 * three columns of every face on the page itself, which worked at 22 faces and
 * stopped working the moment each entry became a real text family worth
 * previewing at reading size. Moving the list into a dialog is what buys the
 * room; the rows stay on the page because seeing all four choices TOGETHER is
 * the point — a wordmark and a body face are a pairing decision.
 */

type Row = {
  slot: FontSlot;
  label: string;
  /** What the slot governs, in the row and again in the dialog. */
  description: string;
  /** Preview/sample text; a function so the brand rows can use real content. */
  sample: (ctx: { wordmark: string; peer: string }) => string;
};

const ROWS: Row[] = [
  {
    slot: 'ui',
    label: 'Interface font',
    description: 'Everything the app itself is set in: menus, tables, buttons, forms.',
    sample: () => 'Handgloves',
  },
  {
    slot: 'logo',
    label: 'Wordmark',
    description: 'The brain’s name in the header. Set it in whatever carries the brand.',
    sample: ({ wordmark }) => wordmark,
  },
  {
    slot: 'title',
    label: 'Peer name',
    description: 'This node’s federation-facing label, shown in the centre of the header.',
    sample: ({ peer }) => peer,
  },
  {
    slot: 'prose',
    label: 'Pages and Notes',
    description:
      'Long-form writing in the editor, on shared pages, and in the PDF export. The one choice that leaves the browser.',
    sample: () => 'The quick brown fox',
  },
];

export function FontRows({
  title = 'Fonts',
  slots,
}: {
  /** Section heading above the cards. */
  title?: string;
  /** Which of the four slots this instance shows, in order. Omit for all —
   *  the Appearance screen splits them across two columns (reading faces left,
   *  header faces right), and each instance owns only its own dialog. */
  slots?: FontSlot[];
} = {}) {
  const { fonts, sizes } = useFonts();
  const [openSlot, setOpenSlot] = React.useState<FontSlot | null>(null);

  const rows = slots ? slots.flatMap((s) => ROWS.filter((r) => r.slot === s)) : ROWS;

  const shell = useQuery({
    queryKey: ['shell'],
    queryFn: () => apiFetch<{ siteName: string | null; peerName: string | null }>('/api/shell'),
  });
  const ctx = {
    wordmark: shell.data?.siteName || 'mantle',
    peer: shell.data?.peerName || 'Peer name',
  };

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="space-y-2">
        {rows.map((row) => {
          const face = fontByKey(fonts[row.slot]);
          const size = FONT_SIZES.find((s) => s.id === sizes[row.slot]);
          return (
            <button
              key={row.slot}
              type="button"
              onClick={() => setOpenSlot(row.slot)}
              className={cn(
                'flex w-full items-center justify-between gap-4 rounded-lg border border-border p-3 text-left transition-colors',
                'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {row.label}
                </span>
                {/* The row IS the preview: the sample is painted in the face
                    currently chosen for this slot, so the page answers "what is
                    my wordmark set in" without opening anything. */}
                <span
                  className="mt-1 block overflow-x-clip overflow-y-visible whitespace-nowrap py-0.5 text-2xl leading-normal text-foreground"
                  style={{ fontFamily: fontFamilyValue(fonts[row.slot]) ?? undefined }}
                >
                  {row.sample(ctx)}
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {row.description}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
                <span className="block font-medium text-foreground">{face?.label ?? '—'}</span>
                <span className="block">{size?.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ONE dialog, fed the open row's props — at most one can be open, so
          four always-mounted copies would be four sets of dialog state for no
          behavior. The key remounts it per slot, resetting the shelf filter. */}
      {(() => {
        const row = rows.find((r) => r.slot === openSlot);
        if (!row) return null;
        return (
          <FontDialog
            key={row.slot}
            slot={row.slot}
            title={row.label}
            description={row.description}
            sample={row.sample(ctx)}
            open
            onOpenChange={(open) => setOpenSlot(open ? row.slot : null)}
          />
        );
      })()}
    </section>
  );
}
