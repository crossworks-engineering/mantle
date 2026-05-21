'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Tab strip shared by the operator view (/debug) and the Journey view
 *  (/debug/journey). Client-only for the active-state highlight. */
const TABS = [
  { href: '/debug', label: 'Operator', exact: true },
  { href: '/debug/journey', label: 'Journey', exact: false },
];

export function DebugTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-border">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              'rounded-t-md px-4 py-2 text-sm font-medium transition-colors ' +
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
