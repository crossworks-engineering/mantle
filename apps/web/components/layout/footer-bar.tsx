'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { navItemMatches } from './nav-items';
import { useTopNavItems } from '@/lib/nav-usage';
import { AssistantButton, HighlightButton } from '@/components/assistant/assistant-dock';

/**
 * Bottom footer toolbar spanning the content area (between the sidebar and the
 * activity rail, bottom-aligned at the Collapse-row level). Centre: the user's
 * five most-used menus (ranked from local usage — see lib/nav-usage). Right: the
 * Highlight-content and Assistant launchers as labelled buttons. The height is
 * published as `--footer-h` on the shell root; <main> and the assistant panel
 * offset against it so nothing hides behind the bar.
 */
export function FooterBar() {
  const pathname = usePathname();
  const top = useTopNavItems(5);

  return (
    <footer
      className="fixed inset-x-0 bottom-0 z-30 flex h-[var(--footer-h)] items-center gap-2 border-t border-border bg-sidebar px-3 transition-[left,right] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[var(--activity-w)]"
      aria-label="Quick actions"
    >
      {/* Centre: top-used menus, absolutely centred so the button cluster on the
          right never shifts them off-centre. Hidden on narrow screens. */}
      <nav
        className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 md:flex"
        aria-label="Frequent pages"
      >
        {top.map((item) => {
          const active = navItemMatches(item, pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              title={item.name}
              className={cn(
                'pointer-events-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="hidden lg:inline">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* Right: the two launchers. */}
      <div className="ml-auto flex items-center gap-1">
        <HighlightButton />
        <AssistantButton />
      </div>
    </footer>
  );
}
