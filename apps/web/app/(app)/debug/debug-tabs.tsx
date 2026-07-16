'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Tab strip for the debug section. Each tab is its own route; client-only
 *  for the active-state highlight. */
const TABS = [
  { href: '/debug', label: 'Overview', exact: true },
  { href: '/debug/spend', label: 'Spend', exact: false },
  { href: '/debug/topics', label: 'Topics', exact: false },
  { href: '/debug/digests', label: 'Digests', exact: false },
  { href: '/debug/facts', label: 'Facts', exact: false },
  { href: '/debug/context', label: 'Context', exact: false },
  { href: '/debug/agents', label: 'Agents', exact: false },
  { href: '/debug/telegram', label: 'Telegram', exact: false },
  { href: '/debug/journey', label: 'Journey', exact: false },
  { href: '/debug/integrity', label: 'Integrity', exact: false },
  { href: '/debug/tool-validation', label: 'Tool validation', exact: false },
  { href: '/debug/sanity', label: 'Sanity check', exact: false },
];

export function DebugTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-nowrap gap-1 overflow-x-auto border-b border-border">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              'shrink-0 whitespace-nowrap rounded-t-md px-3 py-2 text-sm font-medium transition-colors ' +
              (active
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
