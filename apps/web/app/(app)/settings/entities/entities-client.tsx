'use client';

import { useState } from 'react';
import { ArrowRight, Check, GitMerge, Network, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

type Candidate = {
  canonicalId: string;
  canonicalName: string;
  dupId: string;
  dupName: string;
  kind: string;
  tier: 'auto' | 'review';
  reason: string;
};

export function EntitiesClient({ initial }: { initial: Candidate[] }) {
  const toast = useToast();
  const [rows, setRows] = useState<Candidate[]>(initial);
  const [busy, setBusy] = useState<string | null>(null); // dupId in flight

  const remove = (dupId: string) => setRows((r) => r.filter((c) => c.dupId !== dupId));

  const merge = async (c: Candidate) => {
    setBusy(c.dupId);
    const res = await fetch('/api/entities/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canonicalId: c.canonicalId, dupId: c.dupId }),
    });
    setBusy(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return toast.error(j.error ?? 'Merge failed');
    }
    remove(c.dupId);
    toast.success(`Merged “${c.dupName}” → “${c.canonicalName}”`);
  };

  const dismiss = async (c: Candidate) => {
    setBusy(c.dupId);
    const res = await fetch('/api/entities/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idA: c.canonicalId, idB: c.dupId }),
    });
    setBusy(null);
    if (!res.ok) return toast.error('Could not dismiss');
    remove(c.dupId);
  };

  const auto = rows.filter((r) => r.tier === 'auto');
  const review = rows.filter((r) => r.tier === 'review');

  const Row = ({ c }: { c: Candidate }) => (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{c.kind}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-muted-foreground line-through decoration-muted-foreground/40">{c.dupName}</span>
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{c.canonicalName}</span>
      </div>
      <span className="hidden min-w-0 max-w-[40%] truncate text-xs text-muted-foreground sm:block">{c.reason}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={busy === c.dupId} onClick={() => merge(c)}>
          <GitMerge /> Merge
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 text-muted-foreground hover:text-foreground"
          disabled={busy === c.dupId}
          onClick={() => dismiss(c)}
          aria-label="Not a duplicate"
          title="Not a duplicate — don't suggest again"
        >
          <X className="size-4" />
        </Button>
      </div>
    </li>
  );

  const Section = ({ title, hint, list }: { title: string; hint: string; list: Candidate[] }) =>
    list.length === 0 ? null : (
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
          <span className="text-xs text-muted-foreground">{list.length}</span>
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
        <ul className="divide-y divide-border rounded-md border border-border">
          {list.map((c) => (
            <Row key={c.dupId} c={c} />
          ))}
        </ul>
      </section>
    );

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Network className="size-5 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold">Duplicate entities</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Possible same-thing entities split across name variants. Merging re-points every relation
          and fact to the kept entity and folds the other in as an alias (so future mentions resolve
          there). Dismiss a pair to stop suggesting it.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-sm text-muted-foreground">
          <Check className="size-4 text-primary" /> No duplicate candidates — your entity graph is clean.
        </div>
      ) : (
        <>
          <Section
            title="High confidence"
            hint="Evidence-backed (legal-suffix variants, identifiers matched to a contact). Safe to merge."
            list={auto}
          />
          <Section
            title="Needs your eye"
            hint="Name-variant matches — only you know if these are the same person. Merge the right ones, dismiss the rest."
            list={review}
          />
        </>
      )}
    </div>
  );
}
