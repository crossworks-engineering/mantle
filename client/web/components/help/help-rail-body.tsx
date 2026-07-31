'use client';

import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import { Bot, Cog, Info } from 'lucide-react';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { apiFetch } from '@mantle/web-ui/api-fetch';

/**
 * The three-part content, dynamically imported by <HelpRail> so neither this
 * nor react-markdown sits in the shell bundle.
 *
 * Same three sections in the same order on every screen — what it's FOR, how to
 * ask the ASSISTANT, what happens UNDERNEATH — because the repetition is the
 * teaching device. In a narrow column they stack rather than sitting in a
 * dialog, so the reader can keep the screen itself in view while reading.
 */

type HelpSection = { heading: string; markdown: string };
type HelpToolGroup = { slug: string; name: string; toolCount: number; granted: boolean };
type HelpTopic = {
  topic: string;
  title: string;
  about: HelpSection;
  assistant: HelpSection | null;
  technical: HelpSection;
  toolGroups: HelpToolGroup[];
  assistantHint: string | null;
};

function Prose({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-accent">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}

function Section({
  icon: Icon,
  heading,
  children,
}: {
  icon: typeof Info;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {heading}
      </h3>
      {children}
    </section>
  );
}

export function HelpRailBody({ topic }: { topic: string }) {
  const query = useQuery({
    queryKey: ['help', topic],
    queryFn: () => apiFetch<{ help: HelpTopic }>(`/api/help/${topic}`),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const help = query.data?.help;

  if (query.isPending) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  if (query.isError || !help) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
        Couldn&apos;t load the help for this screen.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <Section icon={Info} heading={help.about.heading}>
        <Prose markdown={help.about.markdown} />
      </Section>

      {help.assistant ? (
        <Section icon={Bot} heading={help.assistant.heading}>
          <Prose markdown={help.assistant.markdown} />
        </Section>
      ) : (
        help.assistantHint && (
          /* The capability exists but nobody holds it. Saying so teaches more
             than hiding the section — the reader learns the screen CAN be
             driven by the assistant, and what to do about it. */
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {help.assistantHint}{' '}
            <Link href="/settings/tool-groups" className="underline">
              Tool groups
            </Link>
          </p>
        )
      )}

      <Section icon={Cog} heading={help.technical.heading}>
        <Prose markdown={help.technical.markdown} />
        {help.toolGroups.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
            <span>Tool {help.toolGroups.length === 1 ? 'group' : 'groups'}:</span>
            {help.toolGroups.map((g) => (
              <Link
                key={g.slug}
                href="/settings/tool-groups"
                className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent hover:text-accent-foreground"
                title={`${g.toolCount} tools${g.granted ? '' : ' — not granted to any agent'}`}
              >
                {g.slug}
              </Link>
            ))}
          </p>
        )}
      </Section>
    </div>
  );
}
