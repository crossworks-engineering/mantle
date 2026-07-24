'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Megaphone } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { Badge } from '@mantle/web-ui/ui/badge';
import {
  APP_VERSION,
  CHANGELOG_LAST_SEEN_VERSION_KEY,
  CHANGELOG_SEEN_EVENT,
  VERSION_LABEL,
  versionDetail,
} from '@mantle/web-ui/version';

/**
 * "Version x.y.z" link at the foot of the sidebar nav → /changelog. Shows a
 * "What's new?" pill until this build's changelog has been viewed (localStorage
 * last-seen vs APP_VERSION; the /changelog page stamps it and fires
 * CHANGELOG_SEEN_EVENT so the pill clears without a remount). In the collapsed
 * icon rail the pill becomes the same dot the nav badges use.
 */
export function ChangelogLink({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [showWhatsNew, setShowWhatsNew] = useState(false);

  useEffect(() => {
    const read = () => {
      try {
        setShowWhatsNew(
          window.localStorage.getItem(CHANGELOG_LAST_SEEN_VERSION_KEY) !== APP_VERSION,
        );
      } catch {
        // Storage blocked — default to showing the pill.
        setShowWhatsNew(true);
      }
    };
    read();
    window.addEventListener(CHANGELOG_SEEN_EVENT, read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(CHANGELOG_SEEN_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, []);

  const active = pathname === '/changelog' || pathname.startsWith('/changelog/');

  return (
    <div className="px-3 pb-3 group-data-[nav-collapsed=true]/shell:px-2">
      <Link
        href="/changelog"
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        // Full build identity (version · sha · date) — this is the only place
        // it surfaces since the header wordmark badge was removed.
        title={`${versionDetail()} — changelog`}
        className={cn(
          'relative flex items-center gap-3 rounded-md px-3 py-2 text-xs font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'group-data-[nav-collapsed=true]/shell:justify-center group-data-[nav-collapsed=true]/shell:gap-0 group-data-[nav-collapsed=true]/shell:px-0',
          active
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )}
      >
        <Megaphone className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate group-data-[nav-collapsed=true]/shell:hidden">
          {VERSION_LABEL}
        </span>
        {showWhatsNew && (
          <>
            <Badge className="h-5 px-2 text-[10px] group-data-[nav-collapsed=true]/shell:hidden">
              What&apos;s new?
            </Badge>
            {/* Collapsed: a dot stands in for the pill. */}
            <span
              className="absolute right-1.5 top-1.5 hidden size-2 rounded-full bg-primary ring-2 ring-sidebar group-data-[nav-collapsed=true]/shell:block"
              aria-hidden
            />
          </>
        )}
      </Link>
    </div>
  );
}
