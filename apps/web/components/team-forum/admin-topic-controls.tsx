'use client';

/**
 * Owner-side forum controls for /team-admin?view=topics: the pin toggle
 * (announcement mechanism) and the reply form (an `owner` post — no agent
 * turn; optionally flips the topic to answered/closed in the same call).
 * Server-rendered page + router.refresh() after each mutation, matching the
 * team-admin conventions.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pin, PinOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

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
