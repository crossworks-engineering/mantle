'use client';

/**
 * One Forum topic: a linear, multi-author transcript (member posts as tinted
 * cards, the assistant's and the owner's answers as documents) with a
 * composer at the foot. Live turn streaming rides the SAME machinery as Team
 * Chat — forum turn ids live in the `team-<contactId>.<nonce>` namespace, so
 * /api/team/turn/[turnId]/stream serves them unchanged.
 *
 * Deliberately NOT the assistant chat's two-column prompt/reply grid: a forum
 * thread is a room, not a dialogue — posts flow in one column in order, each
 * carrying its author.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, SendHorizontal } from 'lucide-react';
import { BackLink } from '@/components/layout/back-link';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { COMPOSER_BAND_GRADIENT, COMPOSER_BOX } from '@/lib/composer-style';
import { KindBadge, TopicFlags, type ForumKind, type ForumStatus } from './forum-meta';

type TopicDetail = {
  id: string;
  title: string;
  kind: ForumKind;
  visibility: 'team' | 'private';
  pinned: boolean;
  status: ForumStatus;
  authorName: string;
  postCount: number;
  createdAt: string;
  lastPostAt: string;
  mine: boolean;
};

type Post = {
  id: string;
  authorKind: 'member' | 'owner' | 'agent';
  authorName: string;
  mine: boolean;
  body: string;
  status: 'pending' | 'complete' | 'failed';
  error: string | null;
  attachments: unknown[];
  createdAt: string;
};

type LiveTurn = { turnId: string; status: string | null; text: string };

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ThinkingBubble({ label }: { label: string | null }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-2xl bg-primary/10 px-3.5 py-3 text-foreground">
      <span className="sr-only">The assistant is working</span>
      <span className="flex items-center gap-1" aria-hidden>
        <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60" />
      </span>
      {label && (
        <span className="text-xs text-current opacity-70" aria-hidden>
          {label}
        </span>
      )}
    </div>
  );
}

function Prose({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-accent max-w-none break-words dark:prose-invert [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}

function AuthorLine({ post }: { post: Post }) {
  const roleTag =
    post.authorKind === 'agent' ? 'Assistant' : post.authorKind === 'owner' ? 'Owner' : null;
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <span className="text-sm font-medium">{post.mine ? 'You' : post.authorName}</span>
      {roleTag && (
        <span className="rounded-full border border-border px-1.5 py-px text-[10px] uppercase tracking-wider text-muted-foreground">
          {roleTag}
        </span>
      )}
      <span className="text-[11px] text-muted-foreground">{formatTime(post.createdAt)}</span>
    </div>
  );
}

function PostRow({ post, live }: { post: Post; live: LiveTurn | null }) {
  // A durable pending agent post hosts the live stream (or the bubble alone
  // when the stream hasn't produced text yet / isn't connected).
  if (post.authorKind === 'agent' && post.status === 'pending') {
    return (
      <div>
        <AuthorLine post={post} />
        {live?.text ? (
          <>
            <Prose markdown={live.text} />
            {live.status && <p className="mt-1.5 text-xs text-muted-foreground">{live.status}</p>}
          </>
        ) : (
          <ThinkingBubble label={live?.status ?? null} />
        )}
      </div>
    );
  }
  if (post.status === 'failed') {
    // Members see agent failures as a clean note (details stay owner-side).
    if (post.authorKind !== 'agent') return null;
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        That post couldn&rsquo;t be answered. Ask again, or let the brain admin know.
      </div>
    );
  }
  if (post.authorKind === 'member') {
    return (
      <div
        className={
          'rounded-lg border px-3.5 py-3 ' +
          (post.mine ? 'border-primary/20 bg-primary/5' : 'border-border bg-card')
        }
      >
        <AuthorLine post={post} />
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{post.body}</p>
      </div>
    );
  }
  // Agent + owner posts render as documents.
  return (
    <div>
      <AuthorLine post={post} />
      <Prose markdown={post.body} />
    </div>
  );
}

export function TopicViewClient({
  topicId,
  initialTurnId,
}: {
  topicId: string;
  initialTurnId?: string;
}) {
  const [topic, setTopic] = useState<TopicDetail | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [draft, setDraft] = useState('');
  const [noReply, setNoReply] = useState<boolean | null>(null); // null = follow kind default
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [showJump, setShowJump] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const pinnedRef = useRef(true);
  const openedInitialTurn = useRef(false);

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/team/forum/topics/${topicId}`, { cache: 'no-store' });
      if (r.status === 404 || r.status === 401 || r.status === 400) {
        setNotFound(true);
        return;
      }
      if (!r.ok) return;
      const data = (await r.json()) as { topic: TopicDetail; posts: Post[] };
      setTopic(data.topic);
      setPosts(data.posts);
      // Mark read — best-effort, clears the unread dot on the list.
      void fetch(`/api/team/forum/topics/${topicId}/read`, { method: 'POST' }).catch(() => {});
    } catch {
      /* network blip */
    }
  }, [topicId]);

  const finishTurn = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setLive(null);
    setSending(false);
    void refetch();
  }, [refetch]);

  const openStream = useCallback(
    (turnId: string) => {
      let es: EventSource;
      try {
        es = new EventSource(`/api/team/turn/${turnId}/stream`);
      } catch {
        finishTurn();
        return;
      }
      esRef.current = es;
      setLive({ turnId, status: 'Thinking…', text: '' });
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as {
            type: string;
            data: { label?: string; text?: string; message?: string };
          };
          if (event.type === 'status' && event.data.label) {
            setLive((l) => (l ? { ...l, status: event.data.label ?? l.status } : l));
          } else if (event.type === 'text-delta' && event.data.text) {
            setLive((l) =>
              l ? { ...l, status: null, text: l.text + (event.data.text ?? '') } : l,
            );
          } else if (event.type === 'done' || event.type === 'error') {
            if (event.type === 'error') setSendError(event.data.message ?? 'The turn failed.');
            finishTurn();
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        if (esRef.current === es) finishTurn();
      };
    },
    [finishTurn],
  );

  useEffect(() => {
    void refetch();
    const onFocus = () => {
      // Don't clobber an in-flight stream's optimistic state.
      if (!esRef.current) void refetch();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      esRef.current?.close();
    };
  }, [refetch]);

  // Arriving from "New topic": the turn is already running — attach to it.
  useEffect(() => {
    if (initialTurnId && !openedInitialTurn.current) {
      openedInitialTurn.current = true;
      setSending(true);
      openStream(initialTurnId);
    }
  }, [initialTurnId, openStream]);

  const jumpToBottom = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinnedRef.current = true;
    setShowJump(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    pinnedRef.current = nearBottom;
    setShowJump(!nearBottom);
  }, []);

  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [posts, live]);

  useEffect(() => {
    const content = contentRef.current;
    const el = threadRef.current;
    if (!content || !el) return;
    const obs = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    obs.observe(content);
    return () => obs.disconnect();
  }, []);

  const effectiveNoReply = noReply ?? topic?.kind === 'discussion';

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !topic) return;
    setSendError(null);
    setSending(true);
    pinnedRef.current = true;
    setShowJump(false);

    // Optimistic own post.
    setPosts((p) => [
      ...p,
      {
        id: `optimistic-${crypto.randomUUID()}`,
        authorKind: 'member',
        authorName: 'You',
        mine: true,
        body: text,
        status: 'complete',
        error: null,
        attachments: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    setDraft('');
    if (!effectiveNoReply) setLive({ turnId: '', status: 'Thinking…', text: '' });

    try {
      const r = await fetch(`/api/team/forum/topics/${topicId}/posts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ text, noReply: effectiveNoReply }),
      });
      if (r.status === 202) {
        const data = (await r.json().catch(() => ({}))) as { turnId?: string };
        if (data.turnId) openStream(data.turnId);
        else finishTurn();
        return;
      }
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        setSendError(data.error ?? 'Posting failed — try again.');
        finishTurn();
        return;
      }
      finishTurn();
    } catch {
      setSendError('Could not reach the server — try again.');
      finishTurn();
    }
  };

  if (notFound) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <p className="text-sm text-muted-foreground">
          That topic doesn&rsquo;t exist, or you don&rsquo;t have access to it.
        </p>
        <Button variant="outline" size="sm" asChild>
          <a href="/team/forum">Back to the forum</a>
        </Button>
      </div>
    );
  }
  if (!topic) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  // The live stream needs a host: normally the durable pending post from the
  // refetch after enqueue; before that lands, render a trailing bubble.
  const hasPendingHost = posts.some((p) => p.authorKind === 'agent' && p.status === 'pending');

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="border-b border-border/60 px-6 py-3">
        <div className="mx-auto w-full max-w-3xl">
          <BackLink href="/team/forum">Forum</BackLink>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{topic.title}</h1>
            <TopicFlags pinned={topic.pinned} visibility={topic.visibility} status={topic.status} />
            <KindBadge kind={topic.kind} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Started by {topic.mine ? 'you' : topic.authorName} ·{' '}
            {topic.visibility === 'private'
              ? 'visible to you and the brain owner'
              : 'visible to the whole team'}
          </p>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={threadRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-6"
        >
          <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {posts.map((p) => (
              <PostRow key={p.id} post={p} live={live} />
            ))}
            {live && !hasPendingHost ? (
              live.text ? (
                <div>
                  <div className="mb-1.5 text-sm font-medium text-muted-foreground">Assistant</div>
                  <Prose markdown={live.text} />
                  {live.status && (
                    <p className="mt-1.5 text-xs text-muted-foreground">{live.status}</p>
                  )}
                </div>
              ) : (
                <ThinkingBubble label={live.status} />
              )
            ) : null}
          </div>
        </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="Jump to latest"
            className="absolute bottom-4 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowDown className="size-4" aria-hidden />
          </button>
        )}
      </div>

      <div className={`border-t border-border/60 ${COMPOSER_BAND_GRADIENT} px-6 py-4`}>
        <div className="mx-auto w-full max-w-3xl">
          {sendError ? <p className="mb-2 text-sm text-destructive">{sendError}</p> : null}
          {topic.status === 'closed' ? (
            <p className="py-2 text-center text-sm text-muted-foreground">This topic is closed.</p>
          ) : (
            <>
              <div className="flex items-stretch gap-2">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Reply… (Enter to send, Shift+Enter for a new line)"
                  rows={2}
                  className={`${COMPOSER_BOX} flex-1 resize-none bg-background`}
                  disabled={sending}
                />
                <Button
                  className="h-auto"
                  onClick={() => void send()}
                  disabled={sending || !draft.trim()}
                  aria-label="Post"
                >
                  <SendHorizontal />
                </Button>
              </div>
              <label className="mt-2 flex w-fit items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={effectiveNoReply}
                  onCheckedChange={(v) => setNoReply(v === true)}
                />
                No answer needed — just posting for the team
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
