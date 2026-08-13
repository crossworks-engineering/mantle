import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '../lib/utils';

/**
 * List card — THE selectable list item for master-detail listing screens
 * (style guide §8). One source of truth for the card chrome; screens compose
 * their own anatomy inside (icon, title row, snippet, tags).
 *
 * Selection uses the RadioGroupCard checked idiom (the Appearance galleries):
 * a primary border thickened by a matching ring, over a soft `bg-accent/50`
 * tint. The tint sits on `bg-card` under normal `foreground` text, so it stays
 * readable where a full `bg-accent` fill would not (§2). `data-dimmed` fades
 * disabled/past/off records.
 */
export const listCardClass =
  'block w-full rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[selected=true]:border-primary data-[selected=true]:ring-1 data-[selected=true]:ring-primary data-[selected=true]:bg-accent/50 data-[dimmed=true]:opacity-60';

export interface ListCardProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Render the child element (a `<Link>`, `<div>`, …) instead of a `<button>`. */
  asChild?: boolean;
  /** Primary border + ring with a soft accent tint (the checked-card idiom). */
  selected?: boolean;
  /** Fades the card — disabled agents, past events, drafts, … */
  dimmed?: boolean;
}

export const ListCard = React.forwardRef<HTMLButtonElement, ListCardProps>(
  ({ className, asChild = false, selected, dimmed, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        data-selected={selected || undefined}
        data-dimmed={dimmed || undefined}
        type={asChild ? type : (type ?? 'button')}
        className={cn(listCardClass, className)}
        {...props}
      />
    );
  },
);
ListCard.displayName = 'ListCard';

/** Card title — pair with a leading icon in a flex row where the screen has one. */
export function ListCardTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('truncate text-sm font-medium', className)} {...props} />;
}

/** Two-line body/summary preview under the title. */
export function ListCardSnippet({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-0.5 line-clamp-2 text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}

/** One-line metadata (dates, counts, model ids). */
export function ListCardMeta({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('mt-0.5 truncate text-xs text-muted-foreground', className)} {...props} />
  );
}

/** Wrapping row of `TagPill`s / chips at the card's foot. */
export function ListCardTags({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-1.5 flex flex-wrap gap-1', className)} {...props} />;
}
