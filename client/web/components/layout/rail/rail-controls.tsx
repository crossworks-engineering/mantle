'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { ThemeToggle } from '@mantle/web-ui/theme-toggle';
import { RandomThemeToggle } from '@/components/random-theme-toggle';
import { ProfileMenu, type ProfileIdentity } from './profile-menu';

/**
 * The old header's right-hand cluster, rebuilt as three stacked rows under the
 * brand block: who you are, what the app looks like, and the way into search.
 *
 * One row per job rather than a single strip of icons — a 16rem column has the
 * height to spend and not the width, and the row that names the current theme
 * or shows your own name is worth more than the four pixels it costs. At
 * icon-rail width every row degrades to the icon that was always inside it.
 *
 * The search control is deliberately a BUTTON that looks like a field, not a
 * field: the palette it opens is the real input, and two live text inputs in
 * one column (this and the nav's "Filter menu…" box further down) would be one
 * too many. The shortcut badge is what tells them apart at a glance.
 */
export function RailControls({
  identity,
  onSearchClick,
  onNavigate,
}: {
  identity: ProfileIdentity;
  onSearchClick: () => void;
  onNavigate?: () => void;
}) {
  return (
    // `relative` is load-bearing, exactly as on the rail's other three bands:
    // the aside's `menu` AreaBackdrop is absolutely positioned, and a
    // statically-positioned band paints UNDER it while its siblings paint over
    // — this was the one band that missed it.
    <div className="relative flex shrink-0 flex-col gap-1 border-b border-sidebar-border px-3 py-2 group-data-[nav-collapsed=true]/shell:items-center group-data-[nav-collapsed=true]/shell:gap-1.5 group-data-[nav-collapsed=true]/shell:px-2">
      <ProfileMenu identity={identity} onNavigate={onNavigate} />

      {/* Theme: the current palette's name, the shuffle menu, then light/dark.
          Stacks vertically in the icon rail — two 2rem circles do not fit side
          by side in a 3.5rem column. */}
      <div className="flex items-center gap-1 px-2 group-data-[nav-collapsed=true]/shell:flex-col group-data-[nav-collapsed=true]/shell:px-0">
        <RandomThemeToggle />
        <ThemeToggle />
      </div>

      <SearchButton onClick={onSearchClick} />
    </div>
  );
}

/**
 * How this keyboard spells the search chord. The shortcut itself is registered
 * on `metaKey || ctrlKey` either way, so this only decides what the badge says.
 *
 * Each platform gets its own notation, not a substituted word: ⌘ is a modifier
 * GLYPH and sits flush against the letter, while "Ctrl" is a word and needs the
 * plus or it reads as "CtrlK".
 *
 * It starts as the Mac spelling and corrects itself after mount rather than
 * reading the platform during render: the server has no `navigator`, and a
 * first client render that disagrees with the server's HTML is a hydration
 * mismatch. Everywhere else in the shell this shortcut is spelled ⌘ inside a
 * `title`, which a Linux user only sees on hover; a badge sitting permanently
 * in the rail has to be right.
 */
function useSearchChord(): string {
  const [chord, setChord] = useState('⌘K');
  useEffect(() => {
    if (!/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setChord('Ctrl+K');
  }, []);
  return chord;
}

function SearchButton({ onClick }: { onClick: () => void }) {
  const chord = useSearchChord();
  const hint = `Search (${chord})`;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={hint}
      title={hint}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-foreground/[0.03] px-2.5 py-1.5 text-xs text-muted-foreground transition-colors',
        'hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        'group-data-[nav-collapsed=true]/shell:justify-center group-data-[nav-collapsed=true]/shell:gap-0 group-data-[nav-collapsed=true]/shell:border-transparent group-data-[nav-collapsed=true]/shell:bg-transparent group-data-[nav-collapsed=true]/shell:px-0 group-data-[nav-collapsed=true]/shell:py-2',
      )}
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 text-left group-data-[nav-collapsed=true]/shell:hidden">Search</span>
      <kbd
        className="shrink-0 rounded border border-sidebar-border bg-sidebar px-1 py-px font-sans text-[10px] font-medium leading-normal text-muted-foreground group-data-[nav-collapsed=true]/shell:hidden"
        aria-hidden
      >
        {chord}
      </kbd>
    </button>
  );
}
