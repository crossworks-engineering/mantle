'use client';

import { ListPager } from '@/components/layout/list-pager';
import { useListNav } from '@/lib/use-list-nav';

/**
 * Thin client wrapper that wires `<ListPager>` to the URL via `useListNav`.
 * The senders screen is otherwise server-rendered (tab links + form posts),
 * so we keep the client surface to just this pager footer.
 */
export function SendersPager({
  page,
  total,
  pageSize,
}: {
  page: number;
  total: number;
  pageSize: number;
}) {
  const { go, pending } = useListNav();
  return (
    <ListPager
      page={page}
      total={total}
      pageSize={pageSize}
      pending={pending}
      onGo={(p) => go({ page: p === 1 ? null : p })}
    />
  );
}
