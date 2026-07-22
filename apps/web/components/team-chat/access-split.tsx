'use client';

/**
 * Resizable + collapsible split for the /team-admin Members detail pane: the
 * member's activity (forum posts + answers, requests, chat archive) on top,
 * the Recent-access inspector below, separated by a drag handle. The access panel collapses to just its header bar (chevron
 * click, or dragging it below its minimum), and both the layout and the
 * collapsed state persist in localStorage — the page is URL-driven and
 * re-renders on every member switch, so an inspector you sized up must
 * survive navigation.
 *
 * Mount-gated: the group renders only after mount so the persisted layout
 * never fights server-rendered styles (a static 70/30 stand-in paints first
 * — identical to the default layout, so there is no visible jump unless a
 * custom layout was saved).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ScrollText } from 'lucide-react';
import { usePanelRef, type Layout } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { cn } from '@/lib/utils';

const LS_KEY = 'team-admin.access-split';
/** Collapsed = exactly the header bar. */
const HEADER_PX = '40px';

type Saved = { layout?: Layout; collapsed?: boolean };

function readSaved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

function writeSaved(patch: Saved) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...readSaved(), ...patch }));
  } catch {
    /* private mode etc. — resizing still works, it just won't persist */
  }
}

function AccessHeader({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex h-10 w-full shrink-0 items-center gap-1.5 px-4 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
    >
      <ScrollText className="size-3.5" aria-hidden /> Recent access
      <ChevronDown
        className={cn('ml-auto size-4 transition-transform', collapsed && 'rotate-180')}
        aria-hidden
      />
    </button>
  );
}

export function ThreadAccessSplit({
  thread,
  access,
}: {
  /** The scrollable thread preview (fills the top panel). */
  thread: ReactNode;
  /** The access-log list (scrolls inside the bottom panel). */
  access: ReactNode;
}) {
  const panelRef = usePanelRef();
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [saved, setSaved] = useState<Saved>({});

  useEffect(() => {
    const s = readSaved();
    setSaved(s);
    setCollapsed(s.collapsed === true);
    setMounted(true);
  }, []);

  const toggle = () => {
    const p = panelRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
    // State follows the panel's own notion via onLayoutChanged too, but the
    // chevron must flip immediately even when expand() restores instantly.
    const nowCollapsed = p.isCollapsed();
    setCollapsed(nowCollapsed);
    writeSaved({ collapsed: nowCollapsed });
  };

  if (!mounted) {
    // Static 70/30 stand-in until the persisted layout is known.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-[7] flex-col">{thread}</div>
        <div className="flex min-h-0 flex-[3] flex-col border-t border-border">
          <AccessHeader collapsed={false} onToggle={() => {}} />
        </div>
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation="vertical"
      className="min-h-0 flex-1"
      defaultLayout={saved.layout}
      onLayoutChanged={(layout) => {
        const p = panelRef.current;
        const nowCollapsed = p ? p.isCollapsed() : collapsed;
        setCollapsed(nowCollapsed);
        writeSaved({ layout, collapsed: nowCollapsed });
      }}
    >
      <ResizablePanel id="thread" defaultSize="70%" minSize="30%" className="flex min-h-0 flex-col">
        {thread}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        id="access"
        panelRef={panelRef}
        collapsible
        collapsedSize={HEADER_PX}
        defaultSize={saved.collapsed ? HEADER_PX : '30%'}
        minSize="110px"
        maxSize="70%"
        className="flex min-h-0 flex-col"
      >
        <AccessHeader collapsed={collapsed} onToggle={toggle} />
        {!collapsed && (
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 pb-3">{access}</div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
