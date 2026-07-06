'use client';

/**
 * Reply box on a team change-request (the /team-admin Requests view). Posts the
 * owner's resolution into the member's Team Chat thread, optionally marking the
 * request done. Router-refreshes on success so the list reflects the new state.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { apiSend } from '@/lib/api-fetch';

export function RequestReply({
  taskId,
  contactName,
  done,
}: {
  taskId: string;
  contactName: string | null;
  done: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);

  const send = async (markDone: boolean) => {
    const message = text.trim();
    if (!message || pending) return;
    setPending(true);
    try {
      await apiSend('/api/team-admin/notify', 'POST', { taskId, text: message, markDone });
      toast.success(
        markDone
          ? `Replied to ${contactName ?? 'the member'} and marked the request done.`
          : `Replied to ${contactName ?? 'the member'}.`,
      );
      setText('');
      router.refresh();
    } catch {
      toast.error('Could not send the reply — try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Reply to ${contactName ?? 'the member'} in their chat…`}
        rows={2}
        className="min-h-0 resize-none"
        disabled={pending}
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void send(false)} disabled={pending || !text.trim()}>
          Send reply
        </Button>
        {!done ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void send(true)}
            disabled={pending || !text.trim()}
          >
            Send &amp; mark done
          </Button>
        ) : null}
      </div>
    </div>
  );
}
