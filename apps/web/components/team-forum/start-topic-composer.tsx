'use client';

/**
 * The /team landing's zero-friction topic starter: one box, a Private switch,
 * a "Start topic" button. No title field — the server summarizes the message
 * into one (summarizer worker, heuristic fallback) — and on success the member
 * lands in the new forum thread, where the assistant's answer is already
 * streaming. Team-shell conventions: raw fetch on the team cookie, inline
 * errors, no toasts.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Label } from '@mantle/web-ui/ui/label';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Switch } from '@mantle/web-ui/ui/switch';
import { Textarea } from '@mantle/web-ui/ui/textarea';

export function StartTopicComposer() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const body = text.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/team/forum/topics', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ body, visibility: isPrivate ? 'private' : 'team' }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        topicId?: string;
        turnId?: string;
        error?: string;
      };
      if (!r.ok || !data.topicId) {
        setError(data.error ?? 'Could not start the topic — try again.');
        setSubmitting(false);
        return;
      }
      const turn = data.turnId ? `?turn=${encodeURIComponent(data.turnId)}` : '';
      router.push(`/team/forum/${data.topicId}${turn}`);
    } catch {
      setError('Could not reach the server — try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void start();
          }
        }}
        rows={3}
        placeholder="Ask or share something… a forum topic is started for you, titled automatically. (Enter to start, Shift+Enter for a new line)"
        className="resize-none bg-background"
        disabled={submitting}
      />
      <div className="mt-3 flex items-center justify-between gap-4">
        <Label className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
          Private
          <Switch checked={isPrivate} onCheckedChange={setIsPrivate} disabled={submitting} />
        </Label>
        <SubmitButton pending={submitting} onClick={() => void start()} disabled={!text.trim()}>
          Start topic
        </SubmitButton>
      </div>
      {isPrivate && (
        <p className="mt-2 text-xs text-muted-foreground">
          Private topics are visible only to you and the brain owner, and are never added to the
          brain&rsquo;s shared knowledge.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
