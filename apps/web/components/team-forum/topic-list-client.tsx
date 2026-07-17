'use client';

/**
 * The Forum topic index — the member's landing surface, replacing the 1:1
 * assistant chat. Pinned topics first (owner announcements), then latest
 * activity; every 'team' topic is visible to every member, plus the member's
 * own private ones. The "New topic" dialog is where a thread (and usually the
 * agent's first answer) begins.
 *
 * Public surface conventions match the team shell: raw fetch (team cookie
 * auth), inline errors, no toasts. The shell TokenGates before children
 * render, so a 401 here means mid-session revocation — surfaced as a plain
 * message rather than a second gate.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquarePlus, MessagesSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  FORUM_KINDS,
  KindBadge,
  TopicFlags,
  kindMeta,
  timeAgo,
  type ForumKind,
  type ForumStatus,
} from './forum-meta';

export type ForumTopicItem = {
  id: string;
  title: string;
  kind: ForumKind;
  visibility: 'team' | 'private';
  pinned: boolean;
  status: ForumStatus;
  authorName: string;
  postCount: number;
  lastPostAt: string;
  createdAt: string;
  lastPostAuthor: string | null;
  lastPostPreview: string | null;
  unread: number;
};

function NewTopicDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<ForumKind>('question');
  const [isPrivate, setIsPrivate] = useState(false);
  // The agent-reply default follows the kind (discussion ⇒ off) until the
  // member touches the checkbox themselves.
  const [noReply, setNoReply] = useState(false);
  const [noReplyTouched, setNoReplyTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveNoReply = noReplyTouched ? noReply : kind === 'discussion';

  const create = async () => {
    if (!title.trim() || !body.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/team/forum/topics', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          kind,
          visibility: isPrivate ? 'private' : 'team',
          noReply: effectiveNoReply,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        topicId?: string;
        turnId?: string;
        error?: string;
      };
      if (!r.ok || !data.topicId) {
        setError(data.error ?? 'Could not create the topic — try again.');
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <MessageSquarePlus /> New topic
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New topic</DialogTitle>
          <DialogDescription>
            Start a thread the whole team can read. The assistant answers unless you wave it off.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forum-topic-title">Title</Label>
            <Input
              id="forum-topic-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="One line the team will recognize it by"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ForumKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORUM_KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    <span className="inline-flex items-center gap-2">
                      <span className={`size-1.5 rounded-full ${k.dot}`} aria-hidden />
                      {k.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{kindMeta(kind).hint}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="forum-topic-body">Your post</Label>
            <Textarea
              id="forum-topic-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Ask, propose, or report — the more context, the better the answer."
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={effectiveNoReply}
                onCheckedChange={(v) => {
                  setNoReplyTouched(true);
                  setNoReply(v === true);
                }}
              />
              No answer needed
            </label>
            <label className="flex items-center gap-2 text-sm">
              Private
              <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
            </label>
          </div>
          {isPrivate && (
            <p className="text-xs text-muted-foreground">
              Private topics are visible only to you and the brain owner, and are never added to the
              brain&rsquo;s shared knowledge.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <SubmitButton
            pending={submitting}
            onClick={() => void create()}
            disabled={!title.trim() || !body.trim()}
          >
            Create topic
          </SubmitButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TopicListClient() {
  const [topics, setTopics] = useState<ForumTopicItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/team/forum/topics', { cache: 'no-store' });
      if (r.status === 401) {
        setError('Your team session ended — reload the page to sign in again.');
        return;
      }
      if (!r.ok) return;
      const data = (await r.json()) as { topics: ForumTopicItem[] };
      setTopics(data.topics);
      setError(null);
    } catch {
      /* network blip — keep current state */
    }
  }, []);

  useEffect(() => {
    void refetch();
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetch]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border/60 px-6 py-3">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold">Forum</h1>
            <p className="text-xs text-muted-foreground">
              Shared with the whole team · the brain answers
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="text-muted-foreground" asChild>
              <Link href="/team/assistant">Chat archive</Link>
            </Button>
            <NewTopicDialog />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
        <div className="mx-auto w-full max-w-4xl">
          {error ? (
            <p className="py-10 text-center text-sm text-destructive">{error}</p>
          ) : topics === null ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-label="Loading topics" />
            </div>
          ) : topics.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border bg-muted/30 px-4 py-12 text-center">
              <MessagesSquare className="size-6 text-muted-foreground" aria-hidden />
              <p className="max-w-sm text-sm text-muted-foreground">
                No topics yet. Start one — questions, ideas, reviews, bugs. The whole team sees the
                thread, and the brain answers.
              </p>
              <NewTopicDialog />
            </div>
          ) : (
            <ul className="flex flex-col">
              {topics.map((t) => (
                <li key={t.id} className="border-b border-border/60 last:border-b-0">
                  <Link
                    href={`/team/forum/${t.id}`}
                    className="flex flex-col gap-1 rounded-md px-3 py-3 transition-colors hover:bg-foreground/[0.04]"
                  >
                    <div className="flex items-center gap-2">
                      {t.unread > 0 && (
                        <span
                          className="size-2 shrink-0 rounded-full bg-primary"
                          aria-label={`${t.unread} unread`}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
                      <TopicFlags pinned={t.pinned} visibility={t.visibility} status={t.status} />
                      <KindBadge kind={t.kind} />
                    </div>
                    <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                      <span className="shrink-0">
                        {t.authorName} · {t.postCount} {t.postCount === 1 ? 'post' : 'posts'} ·{' '}
                        {timeAgo(t.lastPostAt)}
                      </span>
                      {t.lastPostPreview && (
                        <span className="min-w-0 truncate">
                          {t.lastPostAuthor ? `${t.lastPostAuthor}: ` : ''}
                          {t.lastPostPreview}
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
