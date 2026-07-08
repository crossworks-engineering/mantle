'use client';

/**
 * The Team Hub — the /team landing for team members. A briefing surface served
 * straight from the brain: hero + "Ask the brain" CTA, the owner's team-shared
 * pages as section cards, live content stats, and the existing chat client one
 * tap away (view switch, no separate route — same token gate, same cookie).
 *
 * Public surface: raw fetch on purpose (apiFetch is the app shell's
 * authenticated wrapper); a 401 anywhere flips back to the token gate.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TeamChatClient } from '@/components/team-chat/team-chat-client';
import { TokenGate } from '@/components/team-chat/token-gate';

type HubSection = {
  token: string;
  title: string;
  icon: string | null;
  summary: string | null;
  updatedAt: string;
};

type HubData = {
  memberName: string | null;
  siteName: string | null;
  version: string;
  sections: HubSection[];
  counts: Record<string, number>;
};

/** Stat tiles, in display order — zero counts are hidden, not shown as 0. */
const STAT_LABELS: [key: string, label: string][] = [
  ['page', 'Pages'],
  ['note', 'Notes'],
  ['file', 'Files'],
  ['table', 'Tables'],
  ['task', 'Tasks'],
  ['event', 'Events'],
  ['journal', 'Journal entries'],
  ['contact', 'Contacts'],
  ['email', 'Emails ingested'],
];

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

export function TeamHubShell() {
  const [data, setData] = useState<HubData | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null); // null = resolving
  const [view, setView] = useState<'hub' | 'chat'>('hub');

  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/team/hub', { cache: 'no-store' });
      if (r.status === 401) {
        setAuthed(false);
        return;
      }
      if (!r.ok) return;
      setData((await r.json()) as HubData);
      setAuthed(true);
    } catch {
      // network blip — leave the current state; the member can retry
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  if (authed === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (!authed) return <TokenGate heading="Team Hub" onAuthed={() => void refetch()} />;
  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (view === 'chat') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/60 px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => setView('hub')}>
            <ArrowLeft />
            Back to the hub
          </Button>
        </div>
        <TeamChatClient />
      </div>
    );
  }

  const brainName = data.siteName ?? 'this brain';
  const firstName = data.memberName?.trim().split(/\s+/)[0];
  const stats = STAT_LABELS.filter(([key]) => (data.counts[key] ?? 0) > 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-5xl px-6 pb-14">
        {/* Top bar */}
        <header className="flex items-center justify-between py-5">
          <span className="text-sm font-semibold">
            {data.siteName ?? <span className="font-logo lowercase">mantle</span>}
          </span>
          <span className="text-xs text-muted-foreground">Team Hub</span>
        </header>

        {/* Hero */}
        <section className="py-12 md:py-16">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Team Hub
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {firstName ? `Welcome, ${firstName}.` : 'Welcome.'}
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted-foreground md:text-lg">
            Everything about {brainName} in one place — the vision, the plan, what&rsquo;s
            shipped, and live numbers — served straight from the brain itself. Anything unclear?
            Ask it directly.
          </p>
          <div className="mt-7">
            <Button size="lg" onClick={() => setView('chat')}>
              <MessageCircle />
              Ask the brain
            </Button>
          </div>
        </section>

        {/* Briefings */}
        <section className="py-8">
          <h2 className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
            Briefings
          </h2>
          {data.sections.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Briefings are being prepared — check back soon, or ask the brain in the meantime.
            </p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {data.sections.map((s) => (
                <a
                  key={s.token}
                  href={`/s/${s.token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="group rounded-lg border border-border bg-card p-5 text-card-foreground transition-colors hover:border-primary/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      {s.icon ? (
                        <span className="text-xl leading-none" aria-hidden>
                          {s.icon}
                        </span>
                      ) : null}
                      <h3 className="font-medium">{s.title}</h3>
                    </div>
                    <ArrowUpRight
                      className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden
                    />
                  </div>
                  {s.summary ? (
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{s.summary}</p>
                  ) : null}
                  <p className="mt-3 text-xs text-muted-foreground">
                    Updated {formatDate(s.updatedAt)}
                  </p>
                </a>
              ))}
            </div>
          )}
        </section>

        {/* Live stats */}
        {stats.length > 0 ? (
          <section className="py-8">
            <h2 className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
              The brain right now
            </h2>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {stats.map(([key, label]) => (
                <div key={key} className="rounded-lg border border-border bg-card p-4 text-card-foreground">
                  <p className="text-2xl font-semibold tabular-nums">
                    {(data.counts[key] ?? 0).toLocaleString('en-GB')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Live counts, straight from the brain&rsquo;s memory — not a slide.
            </p>
          </section>
        ) : null}

        {/* Closing CTA + footer */}
        <section className="py-8">
          <div className="rounded-lg border border-border bg-card p-6 text-card-foreground md:flex md:items-center md:justify-between">
            <div>
              <h2 className="font-medium">Have a question the briefings don&rsquo;t answer?</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The brain knows this project end to end — ask it anything, any time.
              </p>
            </div>
            <Button className="mt-4 md:mt-0" onClick={() => setView('chat')}>
              <MessageCircle />
              Open Team Chat
            </Button>
          </div>
        </section>

        <footer className="flex items-center justify-between border-t border-border/60 pt-5 text-xs text-muted-foreground">
          <span>
            Powered by <span className="font-logo lowercase">mantle</span>
          </span>
          <span>v{data.version}</span>
        </footer>
      </div>
    </div>
  );
}
