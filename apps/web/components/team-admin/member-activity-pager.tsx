'use client';

/**
 * Pager for one member's forum-activity feed on /team-admin (Members tab).
 * Sibling of AdminTopicPager: same ListPager, different param set — it keeps
 * `?contact=` (which member we're reading) and pushes `?apage=`, deliberately
 * NOT `page`, so the Topics tab's own pager and this one can't clobber each
 * other when the owner tabs back and forth.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { ListPager } from '@/components/layout/list-pager';

export function MemberActivityPager({
  page,
  total,
  pageSize,
}: {
  page: number;
  total: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  return (
    <ListPager
      page={page}
      total={total}
      pageSize={pageSize}
      onGo={(p) => {
        const params = new URLSearchParams(searchParams.toString());
        // Drop the Topics tab's state so paging here can't carry a stale
        // topic/search/page cursor back into the URL.
        for (const k of ['view', 'topic', 'q', 'page']) params.delete(k);
        if (p <= 1) params.delete('apage');
        else params.set('apage', String(p));
        const qs = params.toString();
        router.replace(qs ? `/team-admin?${qs}` : '/team-admin', { scroll: false });
      }}
    />
  );
}
