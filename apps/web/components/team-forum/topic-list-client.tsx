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
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowUpDown,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ListPager } from '@/components/layout/list-pager';
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

type TopicListResponse = {
  topics: ForumTopicItem[];
  total: number;
  page: number;
  pageSize: number;
};

type TopicSort = 'activity' | 'newest' | 'oldest' | 'title';

const SORT_LABELS: Record<TopicSort, string> = {
  activity: 'Latest activity',
  newest: 'Newest topics',
  oldest: 'Oldest topics',
  title: 'Title A–Z',
};

const SORTS = Object.keys(SORT_LABELS) as TopicSort[];

export function TopicListClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.get('q')?.trim() ?? '';
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const sortParam = searchParams.get('sort');
  const sort: TopicSort = SORTS.includes(sortParam as TopicSort)
    ? (sortParam as TopicSort)
    : 'activity';

  const [data, setData] = useState<TopicListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(query);

  const go = useCallback(
    (patch: Record<string, string | number | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') params.delete(k);
        else params.set(k, String(v));
      }
      const s = params.toString();
      router.replace(s ? `/team/forum?${s}` : '/team/forum', { scroll: false });
    },
    [router, searchParams],
  );

  const refetch = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (sort !== 'activity') qs.set('sort', sort);
      if (page > 1) qs.set('page', String(page));
      const s = qs.toString();
      const r = await fetch(`/api/team/forum/topics${s ? `?${s}` : ''}`, { cache: 'no-store' });
      if (r.status === 401) {
        setError('Your team session ended — reload the page to sign in again.');
        return;
      }
      if (!r.ok) return;
      setData((await r.json()) as TopicListResponse);
      setError(null);
    } catch {
      /* network blip — keep current state */
    }
  }, [query, sort, page]);

  useEffect(() => {
    void refetch();
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetch]);

  // Debounced search: push ?q= when the INPUT changes. When ?q= moves without
  // an input edit (back/forward, external link), adopt it into the box instead
  // of re-pushing stale text — lastInputRef tells the two cases apart.
  const lastInputRef = useRef(searchInput);
  useEffect(() => {
    if (searchInput === lastInputRef.current) {
      if (query !== searchInput.trim()) {
        lastInputRef.current = query;
        setSearchInput(query);
      }
      return;
    }
    lastInputRef.current = searchInput;
    if (searchInput.trim() === query) return;
    const t = setTimeout(() => go({ q: searchInput.trim() || null, page: null }), 300);
    return () => clearTimeout(t);
  }, [searchInput, query, go]);

  const topics = data?.topics ?? null;
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 20;

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
        <div className="mx-auto mt-3 flex w-full max-w-4xl items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search topics and posts…"
              className="pl-8"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 gap-1 px-2 text-muted-foreground"
                title="Sort topics"
              >
                <ArrowUpDown className="size-3.5" />
                {SORT_LABELS[sort]}
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(v) => go({ sort: v === 'activity' ? null : v, page: null })}
              >
                {SORTS.map((s) => (
                  <DropdownMenuRadioItem key={s} value={s}>
                    {SORT_LABELS[s]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
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
            query ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No topics or posts match “{query}”.
              </p>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border bg-muted/30 px-4 py-12 text-center">
                <MessagesSquare className="size-6 text-muted-foreground" aria-hidden />
                <p className="max-w-sm text-sm text-muted-foreground">
                  No topics yet. Start one — questions, ideas, reviews, bugs. The whole team sees the
                  thread, and the brain answers.
                </p>
                <NewTopicDialog />
              </div>
            )
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

      {topics !== null && (
        <div className="mx-auto w-full max-w-4xl px-6">
          {/* page/total/pageSize all come from the same response snapshot, so
              the pager never mixes a new URL page with a stale total. */}
          <ListPager
            page={data?.page ?? page}
            total={total}
            pageSize={pageSize}
            onGo={(p) => go({ page: p <= 1 ? null : p })}
          />
        </div>
      )}
    </div>
  );
}
