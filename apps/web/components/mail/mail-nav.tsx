'use client';

import Link from 'next/link';
import { cn } from '@mantle/web-ui/lib/utils';
import { buttonVariants } from '@mantle/web-ui/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mantle/web-ui/ui/tooltip';
import { folderIcon, folderLabel } from './folder-icon';

export type FolderLink = {
  /** Full IMAP folder name (e.g. INBOX.Archive). */
  name: string;
  href: string;
  count: number;
  unread: number;
  active: boolean;
};

/**
 * Folder rail for the mail screen. Data-driven from the account's real
 * folders (those with ingested mail). Each entry is a Link that swaps the
 * `?folder=` param; collapse renders icon-only with a tooltip. Adapted from
 * the appearance demo's Nav (which used static buttons + mock counts).
 */
export function MailNav({ isCollapsed, folders }: { isCollapsed: boolean; folders: FolderLink[] }) {
  return (
    <div
      data-collapsed={isCollapsed}
      className="group flex flex-col gap-4 py-2 data-[collapsed=true]:py-2"
    >
      <nav className="grid gap-1 px-2 group-[[data-collapsed=true]]:justify-center group-[[data-collapsed=true]]:px-2">
        {folders.length === 0 && !isCollapsed && (
          <p className="px-2 py-1 text-xs text-muted-foreground">No folders with mail yet.</p>
        )}
        {folders.map((f) => {
          const Icon = folderIcon(f.name);
          const label = folderLabel(f.name);
          const badge = f.unread > 0 ? String(f.unread) : '';
          return isCollapsed ? (
            <Tooltip key={f.name} delayDuration={0}>
              <TooltipTrigger asChild>
                <Link
                  href={f.href}
                  className={cn(
                    buttonVariants({ variant: f.active ? 'default' : 'ghost', size: 'icon' }),
                    'h-9 w-9',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="sr-only">{label}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" className="flex items-center gap-4">
                {label}
                {badge && <span className="ml-auto text-muted-foreground">{badge}</span>}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Link
              key={f.name}
              href={f.href}
              title={`${f.name} · ${f.count} message${f.count === 1 ? '' : 's'}`}
              className={cn(
                buttonVariants({ variant: f.active ? 'default' : 'ghost', size: 'sm' }),
                'justify-start',
              )}
            >
              <Icon className="mr-2 h-4 w-4" />
              <span className="truncate">{label}</span>
              {badge && (
                <span
                  className={cn(
                    'ml-auto',
                    f.active && 'text-background dark:text-muted-foreground',
                  )}
                >
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
