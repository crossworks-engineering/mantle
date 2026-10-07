/**
 * The "Shared with you" menu of a CONTACT share's /s view (contact shares,
 * migration 0214; plan section 6a). Server-rendered, no JavaScript: a
 * `<details>` that opens a plain list of every live share of the contact
 * the CURRENT share names, each a link to that item's own /s/<token>. The
 * current item is marked. Nothing else: no search, no sizes, no levels, no
 * author, no brain name beyond the site name.
 *
 * Two shapes: a thin top strip (the site name, then the button) for pages,
 * notes, files, tables and drawings; a small floating pill in one corner for
 * an app, so the app keeps its whole viewport.
 */
import {
  AppWindow,
  Calculator,
  File as FileIcon,
  FileText,
  PenTool,
  StickyNote,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import type { ContactMenuItem } from '@mantle/content';

const KIND_ICON: Record<string, LucideIcon> = {
  page: FileText,
  note: StickyNote,
  draw: PenTool,
  table: Table2,
  file: FileIcon,
  app: AppWindow,
  formula: Calculator,
};

function ItemIcon({ item }: { item: ContactMenuItem }) {
  // An item's own emoji icon when it has one; else its kind's icon.
  if (item.icon && !item.icon.includes(':') && item.icon.length <= 8) {
    return (
      <span className="w-4 shrink-0 text-center leading-none" aria-hidden>
        {item.icon}
      </span>
    );
  }
  const Icon = KIND_ICON[item.kind] ?? FileIcon;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

export type ContactSharesMenuProps = {
  items: ContactMenuItem[];
  /** More than the menu reads (50): an "and more" line closes the list. */
  more: boolean;
  /** The token of the share this page shows: its row is marked. */
  currentToken: string;
  /** The brain's site name for the strip (null: none). */
  siteName: string | null;
  /** 'strip' for every kind but an app; 'pill' for an app. */
  shape: 'strip' | 'pill';
};

function MenuList({
  items,
  more,
  currentToken,
}: Pick<ContactSharesMenuProps, 'items' | 'more' | 'currentToken'>) {
  return (
    <ul className="space-y-0.5" aria-label="Shared with you">
      {items.map((item) => {
        const current = item.token === currentToken;
        return (
          <li key={item.token}>
            <a
              href={`/s/${encodeURIComponent(item.token)}`}
              aria-current={current ? 'page' : undefined}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted ${
                current ? 'bg-muted font-medium' : ''
              }`}
            >
              <ItemIcon item={item} />
              <span className="min-w-0 flex-1 truncate">{item.title || 'Untitled'}</span>
            </a>
          </li>
        );
      })}
      {more && <li className="px-2 py-1.5 text-xs text-muted-foreground">And more.</li>}
    </ul>
  );
}

export function ContactSharesMenu(props: ContactSharesMenuProps) {
  const label = `Shared with you (${props.items.length}${props.more ? '+' : ''})`;
  if (props.shape === 'pill') {
    return (
      <details className="fixed right-3 bottom-3 z-50 text-foreground" data-contact-menu="pill">
        <summary className="cursor-pointer list-none rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur hover:bg-muted">
          {label}
        </summary>
        <div className="absolute right-0 bottom-full mb-2 max-h-[60vh] w-72 overflow-y-auto scrollbar-thin rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <MenuList {...props} />
        </div>
      </details>
    );
  }
  return (
    <div
      className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border/60 bg-background/90 px-4 py-2 text-sm backdrop-blur"
      data-contact-menu="strip"
    >
      <span className="min-w-0 truncate font-medium">{props.siteName ?? ''}</span>
      <details className="relative shrink-0">
        <summary className="cursor-pointer list-none rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted">
          {label}
        </summary>
        <div className="absolute right-0 z-30 mt-2 max-h-[60vh] w-72 overflow-y-auto scrollbar-thin rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <MenuList {...props} />
        </div>
      </details>
    </div>
  );
}
