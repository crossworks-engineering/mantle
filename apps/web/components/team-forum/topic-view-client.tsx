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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, Loader2, Search, SendHorizontal, X } from 'lucide-react';
import { BackLink } from '@/components/layout/back-link';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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
  attachments: unknown[];
  createdAt: string;
};

type LiveTurn = { turnId: string; status: string | null; text: string };

type Match = {
  id: string;
  authorKind: 'member' | 'owner' | 'agent';
  authorName: string;
  snippet: string;
  createdAt: string;
};

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
  // Older posts fetched via "Load earlier" — kept separate from the live tail
  // window (`posts`, which refetch replaces) and prepended in render order.
  const [earlier, setEarlier] = useState<Post[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // In-thread search: find box, its matches, and the post to briefly highlight
  // once a jumped-to match scrolls into view.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
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
  // Scroll-height snapshot taken before a "Load earlier" prepend so the layout
  // effect can hold the reader's viewport steady as older posts slot in above.
  const prevHeightRef = useRef<number | null>(null);
  // Live mirrors of state read inside async loops / effects without re-binding.
  const postsRef = useRef<Post[]>([]);
  const earlierRef = useRef<Post[]>([]);
  // The id of a search match we're scrolling to once it lands in the DOM.
  const jumpTargetRef = useRef<string | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const r = await fetch(`/api/team/forum/topics/${topicId}`, { cache: 'no-store' });
      if (r.status === 404 || r.status === 401 || r.status === 400) {
        setNotFound(true);
        return;
      }
      if (!r.ok) return;
      const data = (await r.json()) as { topic: TopicDetail; posts: Post[] };
      // The tail window slides forward as posts arrive: anything in the old
      // window but older than the new one would silently fall out and leave a
      // hole between `earlier` and `posts`. Fold those into `earlier` so the
      // loaded transcript stays contiguous (which jumpToMatch relies on).
      const newIds = new Set(data.posts.map((p) => p.id));
      const newOldest = data.posts[0]?.createdAt;
      const dropped = newOldest
        ? postsRef.current.filter(
            (p) =>
              !p.id.startsWith('optimistic-') && !newIds.has(p.id) && p.createdAt < newOldest,
          )
        : [];
      if (dropped.length) {
        setEarlier((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const add = dropped.filter((p) => !seen.has(p.id));
          // Dropped tail posts are newer than everything already in `earlier`.
          return add.length ? [...prev, ...add] : prev;
        });
      }
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

  // Reset the loaded-earlier buffer + search when moving to a different topic.
  useEffect(() => {
    setEarlier([]);
    setMatches(null);
    setSearchInput('');
    setSearchOpen(false);
  }, [topicId]);

  // Older buffer + live tail, de-duped by id (earlier are strictly older, but
  // guard against overlap after a refetch widened the window).
  const allPosts = useMemo(() => {
    const seen = new Set<string>();
    const out: Post[] = [];
    for (const p of [...earlier, ...posts]) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }
    return out;
  }, [earlier, posts]);

  // Keep the async-loop mirrors current.
  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);
  useEffect(() => {
    earlierRef.current = earlier;
  }, [earlier]);

  // Fetch one older page (posts strictly before `beforeIso`, ascending). Pure —
  // no state — so the jump loop can drive it with a locally-tracked cursor.
  const fetchBefore = useCallback(
    async (beforeIso: string): Promise<Post[]> => {
      try {
        const r = await fetch(
          `/api/team/forum/topics/${topicId}?before=${encodeURIComponent(beforeIso)}&limit=50`,
          { cache: 'no-store' },
        );
        if (!r.ok) return [];
        return ((await r.json()) as { posts: Post[] }).posts;
      } catch {
        return [];
      }
    },
    [topicId],
  );

  const prependEarlier = useCallback((fresh: Post[]) => {
    if (!fresh.length) return;
    setEarlier((prev) => {
      const seen = new Set([...prev, ...postsRef.current].map((p) => p.id));
      return [...fresh.filter((p) => !seen.has(p.id)), ...prev];
    });
  }, []);

  // "Load earlier posts" button — holds the viewport steady as older posts slot
  // in (via prevHeightRef + the layout effect below).
  const loadEarlier = useCallback(async () => {
    if (loadingEarlier) return;
    const oldest = earlierRef.current[0] ?? postsRef.current[0];
    if (!oldest) return;
    const el = threadRef.current;
    prevHeightRef.current = el ? el.scrollHeight : null;
    setLoadingEarlier(true);
    prependEarlier(await fetchBefore(oldest.createdAt));
    setLoadingEarlier(false);
  }, [loadingEarlier, fetchBefore, prependEarlier]);

  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && prevHeightRef.current != null) {
      el.scrollTop += el.scrollHeight - prevHeightRef.current;
      prevHeightRef.current = null;
    }
  }, [earlier]);

  // Jump to a search match: page older until it's loaded, then let the jump
  // effect scroll it into view. The cursor is tracked locally so the loop never
  // races the async state updates.
  const jumpToMatch = useCallback(
    async (m: Match) => {
      pinnedRef.current = false;
      const loaded = () => [...earlierRef.current, ...postsRef.current];
      if (loaded().some((p) => p.id === m.id)) {
        // Already on screen — scroll on the next frame.
        jumpTargetRef.current = null;
        requestAnimationFrame(() => {
          const el = document.getElementById(`fpost-${m.id}`);
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            setActiveMatchId(m.id);
          }
        });
        return;
      }
      jumpTargetRef.current = m.id;
      let cursor: string | null = loaded()[0]?.createdAt ?? null;
      let found = false;
      for (let i = 0; i < 100 && !found; i++) {
        if (!cursor || cursor <= m.createdAt) break;
        const fresh = await fetchBefore(cursor);
        const oldest = fresh[0];
        if (!oldest) break;
        prependEarlier(fresh);
        cursor = oldest.createdAt;
        found = fresh.some((p) => p.id === m.id);
      }
      // Couldn't locate it (deleted, or an untraversable gap) — drop the
      // target, unless a newer jump already claimed the ref, so a later
      // unrelated list change can't trigger a surprise scroll.
      if (!found && jumpTargetRef.current === m.id) jumpTargetRef.current = null;
    },
    [fetchBefore, prependEarlier],
  );

  // Debounced in-thread search.
  useEffect(() => {
    const q = searchInput.trim();
    if (!q) {
      setMatches(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/team/forum/topics/${topicId}/search?q=${encodeURIComponent(q)}`, {
          cache: 'no-store',
        });
        if (r.ok) setMatches(((await r.json()) as { matches: Match[] }).matches);
      } catch {
        /* keep prior matches on a blip */
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, topicId]);

  // When a jumped-to match lands in the DOM, scroll to it and flag the highlight.
  useEffect(() => {
    const id = jumpTargetRef.current;
    if (!id) return;
    const el = document.getElementById(`fpost-${id}`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setActiveMatchId(id);
      jumpTargetRef.current = null;
    }
  }, [allPosts]);

  // Fade the highlight after a couple of seconds.
  useEffect(() => {
    if (!activeMatchId) return;
    const t = setTimeout(() => setActiveMatchId(null), 2500);
    return () => clearTimeout(t);
  }, [activeMatchId]);

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

  // More to load when fewer real posts are on screen than the topic's count
  // (optimistic client-only posts don't count against the server total).
  const realLoaded = allPosts.filter((p) => !p.id.startsWith('optimistic-')).length;
  const hasEarlier = !!topic && realLoaded < topic.postCount;

  // The live stream needs a host: normally the durable pending post from the
  // refetch after enqueue; before that lands, render a trailing bubble.
  const hasPendingHost = allPosts.some((p) => p.authorKind === 'agent' && p.status === 'pending');

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="border-b border-border/60 px-6 py-3">
        <div className="mx-auto w-full max-w-3xl">
          <BackLink href="/team/forum">Forum</BackLink>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{topic.title}</h1>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label={searchOpen ? 'Close search' : 'Search this topic'}
              onClick={() => {
                setSearchOpen((o) => !o);
                if (searchOpen) setSearchInput('');
              }}
            >
              {searchOpen ? <X /> : <Search />}
            </Button>
            <TopicFlags pinned={topic.pinned} visibility={topic.visibility} status={topic.status} />
            <KindBadge kind={topic.kind} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Started by {topic.mine ? 'you' : topic.authorName} ·{' '}
            {topic.visibility === 'private'
              ? 'visible to you and the brain owner'
              : 'visible to the whole team'}
          </p>
          {searchOpen && (
            <div className="mt-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search this topic…"
                  className="pl-8"
                />
                {searching && (
                  <Loader2
                    className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
                    aria-hidden
                  />
                )}
              </div>
              {searchInput.trim() && (
                <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border">
                  {matches === null ? (
                    <p className="px-3 py-4 text-center text-xs text-muted-foreground">Searching…</p>
                  ) : matches.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                      No posts match “{searchInput.trim()}”.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {matches.map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => void jumpToMatch(m)}
                            className="block w-full px-3 py-2 text-left transition-colors hover:bg-muted/50"
                          >
                            <div className="flex items-baseline gap-2 text-xs">
                              <span className="font-medium">{m.authorName}</span>
                              <span className="text-muted-foreground">{formatTime(m.createdAt)}</span>
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {m.snippet}
                            </p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={threadRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-6"
        >
          <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {hasEarlier && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadEarlier()}
                  disabled={loadingEarlier}
                >
                  {loadingEarlier ? <Loader2 className="animate-spin" /> : null}
                  Load earlier posts
                </Button>
              </div>
            )}
            {allPosts.map((p) => (
              <div
                key={p.id}
                id={`fpost-${p.id}`}
                className={`rounded-lg transition-shadow ${
                  activeMatchId === p.id
                    ? 'ring-2 ring-primary/60 ring-offset-4 ring-offset-background'
                    : ''
                }`}
              >
                <PostRow post={p} live={live} />
              </div>
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
