import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { countContextTurns, listContextTurns, type ContextTurnRow } from '@/lib/debug';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { DebugPager, DebugSearchBox } from '@/components/debug/list-nav';
import { fmtRelative } from '../format';
import type { ContextSnapshot, SnapshotItem } from '@mantle/agent-runtime';

const PAGE_SIZE = 15;

/**
 * /debug/context — per-turn retrieval audit. One row per responder turn:
 * question | the focused context retrieval actually sent (with ranking
 * distances + near-misses) | the reply. The point is judging whether the
 * context matched the question — so distances and the items each cutoff
 * rejected are first-class, and the response renders as plain text (never
 * markdown) so a long reply can't visually take over the row.
 */
export default async function DebugContextPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;

  const [turns, total] = await Promise.all([
    listContextTurns(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countContextTurns(user.id, { query }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Context" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Retrieval per turn — question · context sent · response
        </h2>
        <DebugSearchBox placeholder="Search questions…" />
      </div>

      {turns.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          {query
            ? 'No turns match your search.'
            : 'No responder turns yet. Ask an agent something (web or Telegram) and the turn will show up here.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {turns.map((t) => (
            <TurnRow key={t.traceId} turn={t} />
          ))}
        </ul>
      )}

      <DebugPager page={page} totalPages={totalPages} total={total} />
    </div>
  );
}

function TurnRow({ turn }: { turn: ContextTurnRow }) {
  return (
    <li className="rounded-md border border-border">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        {turn.agentSlug && <span className="font-medium text-foreground">{turn.agentSlug}</span>}
        {turn.surface && <span>{turn.surface}</span>}
        {turn.model && <code className="font-mono">{turn.model}</code>}
        {turn.status === 'error' && <span className="font-medium text-destructive">error</span>}
        <span className="ml-auto flex items-baseline gap-3">
          <span>{fmtRelative(turn.startedAt)}</span>
          <Link href={`/debug/journey/${turn.traceId}`} className="underline-offset-2 hover:underline">
            trace
          </Link>
        </span>
      </div>
      <div className="grid md:grid-cols-[1fr_1.4fr_1fr] md:divide-x md:divide-border max-md:divide-y max-md:divide-border">
        <QuestionCell turn={turn} />
        <ContextCell snapshot={turn.snapshot} />
        <ResponseCell response={turn.response} />
      </div>
    </li>
  );
}

function QuestionCell({ turn }: { turn: ContextTurnRow }) {
  const snap = turn.snapshot;
  return (
    <div className="space-y-2 p-3">
      <CellLabel>Question</CellLabel>
      {turn.question ? (
        <p className="whitespace-pre-wrap text-sm">{turn.question}</p>
      ) : (
        <p className="text-sm text-muted-foreground">(no inbound text found)</p>
      )}
      {snap?.query.enriched && (
        <div>
          <CellLabel>Embedded as (anaphora-enriched)</CellLabel>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{snap.query.enriched}</p>
        </div>
      )}
      {snap && !snap.query.embedded && (
        <p className="text-xs font-medium text-destructive">
          query was not embedded — retrieval ran without vector search
        </p>
      )}
    </div>
  );
}

function ContextCell({ snapshot }: { snapshot: ContextSnapshot | null }) {
  if (!snapshot) {
    return (
      <div className="p-3">
        <CellLabel>Context sent</CellLabel>
        <p className="mt-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-xs text-muted-foreground">
          No snapshot — this turn ran before retrieval snapshots were recorded.
        </p>
      </div>
    );
  }
  const counts = [
    `${snapshot.history.count} history turns`,
    `${snapshot.digests.count} digests`,
    `${snapshot.personaNotes.count} persona notes`,
  ].join(' · ');
  return (
    <div className="space-y-3 p-3">
      <CellLabel>Context sent</CellLabel>
      <SnapshotSection
        title="Facts"
        items={snapshot.facts.sent}
        dropped={snapshot.facts.dropped}
        cutoffNote={`guard ${snapshot.facts.guard}`}
      />
      <SnapshotSection
        title="Content hits"
        items={snapshot.contentHits.sent}
        dropped={snapshot.contentHits.dropped}
        cutoffNote={`cutoff ${snapshot.contentHits.cutoff}`}
      />
      <SnapshotSection
        title="Passages"
        items={snapshot.chunkHits.sent}
        dropped={snapshot.chunkHits.dropped}
        cutoffNote={`cutoff ${snapshot.chunkHits.cutoff}`}
      />
      {snapshot.relations.length > 0 && (
        <div>
          <CellLabel>Relations ({snapshot.relations.length})</CellLabel>
          <ul className="mt-1 space-y-0.5">
            {snapshot.relations.map((r, i) => (
              <li key={i} className="font-mono text-xs text-muted-foreground">
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {counts}
        {snapshot.digests.topics.length > 0 && (
          <span> · topics: {snapshot.digests.topics.join(', ')}</span>
        )}
      </p>
    </div>
  );
}

/** One retrieval section: sent items with their ranking distance, plus the
 *  near-misses the cutoff rejected behind a native <details>. */
function SnapshotSection({
  title,
  items,
  dropped,
  cutoffNote,
}: {
  title: string;
  items: SnapshotItem[];
  dropped: SnapshotItem[];
  cutoffNote: string;
}) {
  if (items.length === 0 && dropped.length === 0) return null;
  return (
    <div>
      <CellLabel>
        {title} ({items.length})
        <span className="ml-2 font-normal normal-case text-muted-foreground/70">{cutoffNote}</span>
      </CellLabel>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">none sent</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((it, i) => (
            <SnapshotItemLine key={i} item={it} />
          ))}
        </ul>
      )}
      {dropped.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {dropped.length} near {dropped.length === 1 ? 'miss' : 'misses'} (rejected)
          </summary>
          <ul className="mt-1 space-y-1 opacity-60">
            {dropped.map((it, i) => (
              <SnapshotItemLine key={i} item={it} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SnapshotItemLine({ item }: { item: SnapshotItem }) {
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <DistBadge dist={item.dist} />
      <span className="min-w-0">
        {(item.title || item.entity) && (
          <span className="font-medium">
            {item.title ?? item.entity}
            {item.heading ? ` › ${item.heading}` : ''}
            {item.kind ? <span className="font-normal text-muted-foreground"> ({item.kind})</span> : null}
            {item.text ? ' — ' : ''}
          </span>
        )}
        <span className="text-muted-foreground">{item.text}</span>
      </span>
    </li>
  );
}

/** Ranking distance (lower = closer). Null means always-injected. */
function DistBadge({ dist }: { dist: number | null }) {
  return (
    <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] tabular-nums text-muted-foreground">
      {dist == null ? 'pinned' : dist.toFixed(3)}
    </span>
  );
}

function ResponseCell({ response }: { response: string | null }) {
  return (
    <div className="space-y-2 p-3">
      <CellLabel>Response</CellLabel>
      {response ? (
        // Plain text on purpose — rendering markdown here would let a long
        // reply visually swamp the audit row.
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
          {response}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">(no outbound reply found)</p>
      )}
    </div>
  );
}

function CellLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
