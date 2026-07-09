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
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Cloud,
  ExternalLink,
  FileCheck2,
  FolderTree,
  MessageCircle,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppSandbox } from '@/components/app-sandbox/app-sandbox';
import { TeamChatClient } from '@/components/team-chat/team-chat-client';
import { TokenGate } from '@/components/team-chat/token-gate';
import type { HubNavTarget } from '@/lib/app-bridge/protocol';

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
  /** Present when this brain designated a team-hub APP (pref + green published
   *  build + active team-mode share all intact) — the shell renders it
   *  full-bleed instead of the built-in hub body below. */
  hubApp?: { appId: string; shareToken: string } | null;
};

/** The "What's new" strip — the latest platform improvements, in simple terms.
 *  Curated by hand alongside releases; every entry ships in the running build.
 *  Class strings are literal (Tailwind v4 — no dynamic class construction). */
const WHATS_NEW: {
  icon: typeof Cloud;
  title: string;
  blurb: string;
  chip: string;
  delay: string;
}[] = [
  {
    icon: Cloud,
    title: 'SharePoint connection',
    blurb:
      'Connect a Microsoft account and the document libraries of the SharePoint sites you follow flow straight into the brain\u2019s memory.',
    chip: 'bg-chart-1/15 text-chart-1',
    delay: '[animation-delay:0ms]',
  },
  {
    icon: FolderTree,
    title: 'OneDrive browser',
    blurb:
      'Browse OneDrive and SharePoint drives from inside Mantle and tick exactly which folders and files sync \u2014 nothing more.',
    chip: 'bg-chart-2/15 text-chart-2',
    delay: '[animation-delay:80ms]',
  },
  {
    icon: SlidersHorizontal,
    title: 'Brain rules (fine-tuning)',
    blurb:
      'Every tool the brain uses now carries precise rules for when and how to use it \u2014 a deep tuning pass that makes its actions dramatically more dependable.',
    chip: 'bg-chart-3/15 text-chart-3',
    delay: '[animation-delay:160ms]',
  },
  {
    icon: BookOpen,
    title: 'Read without leaving',
    blurb:
      'Briefings on this hub now open in place \u2014 read the document and tap straight back, no new tabs.',
    chip: 'bg-chart-4/15 text-chart-4',
    delay: '[animation-delay:240ms]',
  },
  {
    icon: ShieldCheck,
    title: 'Checked tool use',
    blurb:
      'Every action the assistant takes is validated before it runs \u2014 checked, bounded, and reported truthfully.',
    chip: 'bg-chart-5/15 text-chart-5',
    delay: '[animation-delay:320ms]',
  },
  {
    icon: FileCheck2,
    title: 'Self-healing page edits',
    blurb:
      'Assistant edits land exactly on the paragraph they meant \u2014 and documents repair themselves if anything drifts.',
    chip: 'bg-chart-1/15 text-chart-1',
    delay: '[animation-delay:400ms]',
  },
];

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
  const [view, setView] = useState<'hub' | 'chat' | { briefing: HubSection }>('hub');
  // The designated hub app's bundle failed to load — fall back to the built-in
  // hub for the rest of this visit rather than showing members a broken slot.
  const [hubAppFailed, setHubAppFailed] = useState(false);

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

  if (typeof view === 'object') {
    // In-hub reader: the briefing renders in a same-origin iframe of its /s
    // page (auth rides the team cookie), so members read without leaving the
    // hub. Same-origin means no sandbox gymnastics and full share styling.
    const s = view.briefing;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => setView('hub')}>
            <ArrowLeft />
            Back to the hub
          </Button>
          <p className="min-w-0 truncate text-sm font-medium">
            {s.icon ? <span className="mr-1.5">{s.icon}</span> : null}
            {s.title}
          </p>
          <Button variant="ghost" size="sm" asChild aria-label="Open in a new tab">
            <a href={`/s/${s.token}`} target="_blank" rel="noreferrer">
              <ExternalLink />
            </a>
          </Button>
        </div>
        <iframe
          src={`/s/${s.token}`}
          title={s.title}
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      </div>
    );
  }

  // Designated hub app — render it full-bleed in place of the built-in hub
  // body. The shell keeps everything that must be core (the gate above, chat,
  // the reader); the app reaches those only via validated hub.nav intents. Any
  // load failure flips to the built-in hub below — designation must never cost
  // members a working hub.
  if (data.hubApp && !hubAppFailed) {
    const { appId, shareToken } = data.hubApp;
    const onNav = (target: HubNavTarget) => {
      if (target === 'chat') {
        setView('chat');
        return;
      }
      // Only open briefings that are REAL hub sections (active team-mode page
      // shares) — never navigate to an arbitrary token an app hands us.
      const section = data.sections.find((s) => s.token === target.briefing);
      if (section) setView({ briefing: section });
    };
    return (
      <div className="min-h-0 flex-1">
        <AppSandbox
          appId={appId}
          shareToken={shareToken}
          frame="viewport"
          hub={{
            getData: () => ({
              siteName: data.siteName,
              memberName: data.memberName,
              version: data.version,
              sections: data.sections,
              counts: data.counts,
            }),
            onNav,
          }}
          onLoadFailure={() => setHubAppFailed(true)}
        />
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

        {/* What's new */}
        <section className="py-8">
          <div className="flex items-center gap-2.5">
            <span className="relative flex size-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <h2 className="bg-gradient-to-r from-foreground to-foreground/55 bg-clip-text text-sm font-medium uppercase tracking-widest text-transparent">
              What&rsquo;s new
            </h2>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {WHATS_NEW.map((f) => (
              <div
                key={f.title}
                className={`group relative animate-in fade-in slide-in-from-bottom-3 fill-mode-both overflow-hidden rounded-xl border border-border bg-card p-5 text-card-foreground duration-700 transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg ${f.delay}`}
              >
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                  aria-hidden
                />
                <div className="flex items-start justify-between gap-3">
                  <span className={`inline-flex size-9 items-center justify-center rounded-lg ${f.chip}`}>
                    <f.icon className="size-4.5" aria-hidden />
                  </span>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                    New
                  </span>
                </div>
                <h3 className="mt-3 font-medium">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.blurb}</p>
              </div>
            ))}
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
                  onClick={(e) => {
                    // Plain click opens the in-hub reader; modified clicks
                    // (new tab / window) keep native anchor behaviour.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    setView({ briefing: s });
                  }}
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
