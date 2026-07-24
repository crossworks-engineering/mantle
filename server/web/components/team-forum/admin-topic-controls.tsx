'use client';

/**
 * Owner-side forum controls for /team-admin?view=topics: the pin toggle
 * (announcement mechanism) and the reply form (an `owner` post — no agent
 * turn; optionally flips the topic to answered/closed in the same call).
 * Server-rendered page + router.refresh() after each mutation, matching the
 * team-admin conventions.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Pin, PinOff, Search } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Checkbox } from '@mantle/web-ui/ui/checkbox';
import { Input } from '@mantle/web-ui/ui/input';
import { ListPager } from '@mantle/web-ui/layout/list-pager';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Textarea } from '@mantle/web-ui/ui/textarea';
import { useToast } from '@mantle/web-ui/ui/toast';

/** Owner topic-list search box (title OR post body). Debounced; pushes `?q=`
 *  and drops `page`/`topic` so results start on page 1 with the first match.
 *  When ?q= moves without an input edit (back/forward, external link), the box
 *  adopts it instead of re-pushing stale text — lastInputRef tells the cases
 *  apart. */
export function AdminTopicSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const lastInputRef = useRef(initialQuery);

  const query = searchParams.get('q')?.trim() ?? '';
  useEffect(() => {
    if (value === lastInputRef.current) {
      if (query !== value.trim()) {
        lastInputRef.current = query;
        setValue(query);
      }
      return;
    }
    lastInputRef.current = value;
    if (value.trim() === query) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('view', 'topics');
      params.delete('page');
      params.delete('topic');
      if (value.trim()) params.set('q', value.trim());
      else params.delete('q');
      router.replace(`/team-admin?${params.toString()}`, { scroll: false });
    }, 300);
    return () => clearTimeout(t);
  }, [value, query, searchParams, router]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search topics and posts…"
        className="pl-8"
      />
    </div>
  );
}

/** Owner topic-list pager — preserves the active `q` while paging. */
export function AdminTopicPager({
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
        params.set('view', 'topics');
        if (p <= 1) params.delete('page');
        else params.set('page', String(p));
        router.replace(`/team-admin?${params.toString()}`, { scroll: false });
      }}
    />
  );
}

export function TopicPinToggle({ topicId, pinned }: { topicId: string; pinned: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await fetch('/api/team-admin/forum/pin', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ topicId, pinned: !pinned }),
          });
          if (!r.ok) {
            const data = (await r.json().catch(() => ({}))) as { error?: string };
            toast.error(data.error ?? 'Could not update the pin');
          }
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {pinned ? <PinOff /> : <Pin />}
      {pinned ? 'Unpin' : 'Pin'}
    </Button>
  );
}

export function TopicReplyForm({ topicId, status }: { topicId: string; status: string }) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState('');
  const [markAnswered, setMarkAnswered] = useState(true);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/team-admin/forum/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topicId,
          text: text.trim(),
          ...(markAnswered && status === 'open' ? { status: 'answered' } : {}),
        }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? 'Could not post the reply');
      } else {
        setText('');
        toast.success('Posted to the topic');
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Reply as the brain owner — every member sees it in the thread…"
        disabled={busy}
      />
      <div className="flex items-center justify-between gap-3">
        {status === 'open' ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={markAnswered} onCheckedChange={(v) => setMarkAnswered(v === true)} />
            Mark topic answered
          </label>
        ) : (
          <span />
        )}
        <SubmitButton pending={busy} onClick={() => void send()} disabled={!text.trim()}>
          Post reply
        </SubmitButton>
      </div>
    </div>
  );
}
