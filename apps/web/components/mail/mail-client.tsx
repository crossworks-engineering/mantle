'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AccountSwitcher, type MailAccount } from './account-switcher';
import { MailNav, type FolderLink } from './mail-nav';

const NAV_COLLAPSED_PCT = 4;

/**
 * Three-pane mail shell (account/folder rail · message list · reader),
 * promoted from the appearance "Mail" demo. Server data drives everything:
 * the nav + switcher emit URL-param Links/navigation (no Zustand), and the
 * list + reader arrive as server-rendered slots so sanitization and
 * owner-scoped queries stay on the server.
 */
export function MailClient({
  accounts,
  currentAccountId,
  folders,
  folderTitle,
  tab,
  tabAllHref,
  tabUnreadHref,
  listSlot,
  readerSlot,
  defaultCollapsed = false,
}: {
  accounts: MailAccount[];
  currentAccountId: string;
  folders: FolderLink[];
  folderTitle: string;
  tab: 'all' | 'unread';
  tabAllHref: string;
  tabUnreadHref: string;
  listSlot: React.ReactNode;
  readerSlot: React.ReactNode;
  defaultCollapsed?: boolean;
}) {
  const [isCollapsed, setIsCollapsed] = React.useState(defaultCollapsed);

  return (
    // Offsets track the shell's collapsible sidebar / live column via the
    // `--nav-w` / `--activity-w` CSS vars, so the mail shell stays flush
    // against the global nav and live-activity column at any collapse state.
    <div className="fixed inset-x-0 bottom-0 top-16 z-10 overflow-hidden bg-background transition-[left,right] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[var(--activity-w)]">
      <TooltipProvider delayDuration={0}>
        <ResizablePanelGroup
          orientation="horizontal"
          onLayoutChanged={(layout) => {
            document.cookie = `react-resizable-panels:layout:mail=${JSON.stringify(layout)}; path=/`;
          }}
          className="h-full items-stretch"
        >
          {/* Pane 1 — account switcher + folder rail + approvals */}
          <ResizablePanel
            defaultSize="20%"
            collapsedSize={`${NAV_COLLAPSED_PCT}%`}
            collapsible
            minSize="15%"
            maxSize="22%"
            onResize={(panelSize) => {
              const collapsed = panelSize.asPercentage <= NAV_COLLAPSED_PCT;
              setIsCollapsed(collapsed);
              document.cookie = `react-resizable-panels:collapsed=${JSON.stringify(collapsed)}; path=/`;
            }}
            className={cn(isCollapsed && 'min-w-[50px] transition-all duration-300 ease-in-out')}
          >
            <div className={cn('flex items-center justify-center px-2 py-2', isCollapsed && 'px-0')}>
              <AccountSwitcher
                isCollapsed={isCollapsed}
                accounts={accounts}
                currentAccountId={currentAccountId}
              />
            </div>
            <Separator />
            <MailNav isCollapsed={isCollapsed} folders={folders} />
            <Separator />
            <div className={cn('p-2', isCollapsed && 'flex justify-center p-1')}>
              <Link
                href="/settings/discover"
                title="Discover senders not yet in your contacts"
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  isCollapsed && 'justify-center px-0',
                )}
              >
                <UserCheck className="size-4 shrink-0" aria-hidden />
                {!isCollapsed && <span>Discover</span>}
              </Link>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Pane 2 — folder title + All/Unread tabs + message list */}
          <ResizablePanel defaultSize="32%" minSize="25%">
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 px-4 py-2">
                <h1 className="text-foreground truncate text-xl font-bold">{folderTitle}</h1>
                <div className="ml-auto flex items-center gap-1 text-sm">
                  <Link
                    href={tabAllHref}
                    className={cn(
                      'rounded px-2 py-1',
                      tab === 'all' ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
                    )}
                  >
                    All mail
                  </Link>
                  <Link
                    href={tabUnreadHref}
                    className={cn(
                      'rounded px-2 py-1',
                      tab === 'unread'
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    Unread
                  </Link>
                </div>
              </div>
              <Separator />
              <div className="bg-background/95 supports-[backdrop-filter]:bg-background/60 p-3 backdrop-blur">
                <div className="relative">
                  <Search className="text-muted-foreground absolute top-2.5 left-2 h-4 w-4" aria-hidden />
                  <Input placeholder="Search (coming soon)" disabled className="pl-8" />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">{listSlot}</div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Pane 3 — reader */}
          <ResizablePanel defaultSize="48%" minSize="30%">
            {readerSlot}
          </ResizablePanel>
        </ResizablePanelGroup>
      </TooltipProvider>
    </div>
  );
}
