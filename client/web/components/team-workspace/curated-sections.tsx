'use client';

/**
 * Curated tag sections on the /team overview — the owner's picked tags
 * (Team admin → "Dashboard sections"), each listing up to 5 team-visible
 * shared pages carrying the tag, newest-updated first. Data is derived
 * entirely from active shares; the pref only groups (see /api/team/curated).
 *
 * Renders NOTHING until sections arrive and only when at least one has items,
 * so brains without curation keep a zero-footprint Dashboard. Failures are
 * silent for the same reason — a broken extras block must not degrade the
 * overview (the tiles above are the primary navigation).
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { teamFetch } from '@mantle/web-ui/team-fetch';
import type { CuratedTeamSection } from '@mantle/content';

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Display-case a stored (lowercase) tag as a section heading. */
function headingFor(tag: string): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

export function CuratedSections() {
  const [sections, setSections] = useState<CuratedTeamSection[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await teamFetch('/api/team/curated', { cache: 'no-store' });
        if (!r.ok) return;
        const body = (await r.json()) as { sections?: CuratedTeamSection[] };
        if (!cancelled && Array.isArray(body.sections)) setSections(body.sections);
      } catch {
        // silent — see the header comment
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!sections || sections.length === 0) return null;

  return (
    <div className="mt-10 flex flex-col gap-8">
      {sections.map((section) => (
        <section key={section.tag} aria-label={`${headingFor(section.tag)} — curated pages`}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {headingFor(section.tag)}
          </h2>
          <ul className="mt-3 flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
            {section.items.map((item) => (
              <li key={item.token}>
                {/* Into the workspace reader (/team/pages?s=), not a bare /s/
                    navigation — the shell's own deep-link idiom (folder chips
                    do the same), so reading a featured page keeps the nav.
                    The pages section's tree view loads the whole visible set,
                    so the ?s= selection resolves. */}
                <Link
                  href={`/team/pages?s=${item.token}`}
                  className="block px-4 py-3 hover:bg-muted/40"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium">
                      {item.icon ? <span className="mr-1.5">{item.icon}</span> : null}
                      {item.title || 'Untitled'}
                    </p>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {relTime(item.updatedAt)}
                    </span>
                  </div>
                  {item.summary ? (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {item.summary}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
