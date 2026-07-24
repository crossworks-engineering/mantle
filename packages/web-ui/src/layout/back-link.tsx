import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Standard "back" link for detail pages — a subtle muted text link with a
 * leading arrow that brightens on hover. Use this at the top of any
 * detail/sub-page (e.g. `<BackLink href="/notes">All notes</BackLink>`)
 * so the affordance looks the same everywhere.
 */
export function BackLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground',
        className,
      )}
    >
      <ArrowLeft className="size-4" aria-hidden />
      {children}
    </Link>
  );
}
