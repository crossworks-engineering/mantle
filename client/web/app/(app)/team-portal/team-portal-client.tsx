'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Contact, ExternalLink, Info, MessagesSquare, UserPlus } from 'lucide-react';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@mantle/web-ui/ui/card';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';

type Member = {
  contactId: string;
  contactName: string;
  memberSince: string;
  tokenLastUsedAt: string | null;
};

/**
 * The signpost. Three jobs, in the order an owner needs them: show who can get
 * in today, explain how anyone gets in at all, and let the owner open the
 * portal themselves to see what a member sees.
 */
export function TeamPortalClient() {
  const rosterQuery = useQuery({
    queryKey: ['team-portal'],
    queryFn: () => apiFetch<{ members: Member[] }>('/api/team-portal'),
  });

  const members = rosterQuery.data?.members ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Team Portal</h1>
        <p className="text-sm text-muted-foreground">
          The portal is where people you trust ask your brain questions, without an account and
          without reaching anything you haven&apos;t allowed. It lives outside this app — the button
          below opens it in a new tab so you can see exactly what they see.
        </p>
      </header>

      {/* The one rule that explains every "why can't they get in?" question. */}
      <p className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-sm text-info-ink">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Only a <strong>contact</strong> can reach the portal, using a token you mint for them.
          There is no sign-up, and no password — the token is the whole credential.
        </span>
      </p>

      <div className="flex flex-wrap gap-2">
        <Button asChild>
          {/* The portal is outside the app shell and expects a member credential,
              so it opens beside the owner's session rather than replacing it. */}
          <a href="/team" target="_blank" rel="noopener noreferrer">
            <ExternalLink />
            Open the portal
          </a>
        </Button>
        <Button asChild variant="outline">
          <Link href="/contacts">
            <UserPlus />
            Mint a token in Contacts
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/team-admin">
            <MessagesSquare />
            Read what they&apos;ve asked
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Who can get in ({members.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rosterQuery.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : rosterQuery.isError ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Couldn&apos;t load the roster.
            </p>
          ) : members.length === 0 ? (
            <div className="space-y-2 py-6 text-center">
              <p className="text-sm text-muted-foreground">
                Nobody has a token yet, so the portal is reachable by no one.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href="/contacts">
                  <Contact />
                  Choose a contact to invite
                </Link>
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {members.map((m) => (
                <li key={m.contactId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{m.contactName}</p>
                    <p className="text-xs text-muted-foreground">
                      Member since {formatDateTime(m.memberSince)}
                    </p>
                  </div>
                  {/* A minted-but-never-used token is the usual cause of "the
                      link you sent me doesn't work" — worth calling out. */}
                  <span
                    className={
                      m.tokenLastUsedAt
                        ? 'shrink-0 text-xs text-muted-foreground'
                        : 'shrink-0 text-xs text-warning-ink'
                    }
                  >
                    {m.tokenLastUsedAt
                      ? `Last in ${formatDateTime(m.tokenLastUsedAt)}`
                      : 'Never signed in'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <section className="space-y-2 text-sm text-muted-foreground">
        <h2 className="text-sm font-semibold text-foreground">How access works</h2>
        <p>
          Membership is a role a contact holds, not a separate account. Minting a token from a
          contact&apos;s page is what creates the role; the token is shown once, so copy it then and
          send it to them yourself.
        </p>
        <p>
          Revoking is the same move in reverse. Delete the token — or the contact — and their access
          ends immediately, mid-session, because every request re-checks that the membership is
          still live.
        </p>
        <p>
          Everyone in the portal can read whatever the team responder can read, and can change
          nothing. Their only write is filing a request into your review queue. Your email and
          journal stay out of reach unless you deliberately switch private reads on.
        </p>
      </section>
    </div>
  );
}
