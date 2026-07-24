'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '@mantle/web-ui/ui/badge';
import {
  APP_VERSION,
  CHANGELOG_LAST_SEEN_VERSION_KEY,
  CHANGELOG_SEEN_EVENT,
} from '@mantle/web-ui/version';

/**
 * Changelog reader body. Visiting any /changelog page counts as "read": it
 * stamps the running APP_VERSION into localStorage and fires the seen event
 * so the sidebar "What's new?" pill clears without a remount.
 */
export function ChangelogView({
  version,
  isLatest,
  markdown,
  otherVersions,
}: {
  version: string;
  isLatest: boolean;
  markdown: string;
  otherVersions: string[];
}) {
  useEffect(() => {
    try {
      window.localStorage.setItem(CHANGELOG_LAST_SEEN_VERSION_KEY, APP_VERSION);
      window.dispatchEvent(new Event(CHANGELOG_SEEN_EVENT));
    } catch {
      // Storage blocked — the pill just stays; nothing to do.
    }
  }, []);

  return (
    <article className="mx-auto max-w-3xl px-6 py-8 md:py-12">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{isLatest ? `Latest: v${version}` : `v${version}`}</Badge>
        {!isLatest && (
          <Link
            href="/changelog"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Jump to latest
          </Link>
        )}
      </div>

      <div className="prose dark:prose-invert max-w-none prose-accent">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>

      <nav className="mt-12 space-y-2 border-t pt-4">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {isLatest ? 'Previous versions' : 'Other versions'}
        </h2>
        {otherVersions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other versions yet.</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {otherVersions.map((v) => (
              <Link
                key={v}
                href={`/changelog/${v}`}
                className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                v{v}
              </Link>
            ))}
          </div>
        )}
      </nav>
    </article>
  );
}
