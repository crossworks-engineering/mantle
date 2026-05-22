'use client';

/**
 * PersonaNotesEditor — the human window into an agent's Layer-1 persona notes
 * (what it has *learned*, as opposed to the seed system prompt it was *given*).
 * Notes are normally written by the reflector + the update_persona tool; this
 * lets the operator see and curate them. Mutations hit
 * /api/agents/[id]/persona and respect the soft-retire model — edits supersede
 * (old kept in the audit tail), retire hides, restore brings back. Self-
 * contained: persists immediately, independent of the parent agent form.
 */

import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format-datetime';
import type { PersonaNote } from '@mantle/db';

type Kind = PersonaNote['kind'];

const KIND_LABEL: Record<Kind, string> = {
  style: 'Style',
  relationship: 'Relationship',
  correction: 'Correction',
};

const KIND_BADGE: Record<Kind, string> = {
  style: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  relationship: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  correction: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

/** Match the server's noteRef: real id when present, else a short sha256 of
 *  the content (for legacy id-less notes). Uses Web Crypto on the client. */
async function refOf(n: PersonaNote): Promise<string> {
  if (n.id) return n.id;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(n.content));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

function sourceLabel(n: PersonaNote): string {
  if (n.source?.type === 'turn') return 'from a conversation';
  if (n.source?.type === 'digest') return 'from a digest';
  return 'learned / added';
}

type Action =
  | { action: 'add'; kind: Kind; content: string }
  | { action: 'edit'; ref: string; kind: Kind; content: string }
  | { action: 'retire'; ref: string }
  | { action: 'restore'; ref: string };

export function PersonaNotesEditor({
  agentId,
  initialNotes,
}: {
  agentId: string;
  initialNotes: PersonaNote[];
}) {
  const [notes, setNotes] = useState<PersonaNote[]>(initialNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<Kind>('style');
  const [addText, setAddText] = useState('');

  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editKind, setEditKind] = useState<Kind>('style');

  const active = useMemo(() => notes.filter((n) => !n.retiredAt), [notes]);
  const retired = useMemo(() => notes.filter((n) => n.retiredAt), [notes]);

  async function call(body: Action): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/persona`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        agent?: { personaNotes?: PersonaNote[] };
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      setNotes(data.agent?.personaNotes ?? []);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitAdd() {
    if (!addText.trim()) return;
    if (await call({ action: 'add', kind: addKind, content: addText.trim() })) {
      setAddText('');
      setAddOpen(false);
    }
  }

  async function startEdit(n: PersonaNote) {
    setEditingRef(await refOf(n));
    setEditText(n.content);
    setEditKind(n.kind);
  }

  async function saveEdit() {
    if (!editingRef || !editText.trim()) return;
    if (await call({ action: 'edit', ref: editingRef, kind: editKind, content: editText.trim() })) {
      setEditingRef(null);
      setEditText('');
    }
  }

  async function retire(n: PersonaNote) {
    await call({ action: 'retire', ref: await refOf(n) });
  }

  async function restore(n: PersonaNote) {
    await call({ action: 'restore', ref: await refOf(n) });
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">What this agent has learned</h4>
          <p className="text-xs text-muted-foreground">
            Persona notes the reflector and the agent itself build up over time. This is what it{' '}
            <em>believes</em> about how you want to be helped — the seed prompt above is what it was{' '}
            <em>told</em>. Edits keep history; nothing is hard-deleted.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setAddOpen((v) => !v)}
          disabled={busy}
        >
          <Plus /> Add
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {addOpen && (
        <div className="space-y-2 rounded-md border border-border bg-background p-2">
          <KindSelect value={addKind} onChange={setAddKind} />
          <textarea
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            rows={2}
            placeholder='e.g. "Prefers concise answers with no emoji."'
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={submitAdd} disabled={busy || !addText.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : 'Add note'}
            </Button>
          </div>
        </div>
      )}

      {active.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          Nothing learned yet. As you chat, the reflector will note durable preferences here — or add
          one yourself.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {active.map((n, i) => {
            const k = n.id ?? `idx-${i}`;
            const isEditing = editingRef !== null && (n.id === editingRef);
            return (
              <li
                key={k}
                className="rounded-md border border-border bg-background px-2.5 py-2 text-sm"
              >
                {isEditing ? (
                  <div className="space-y-2">
                    <KindSelect value={editKind} onChange={setEditKind} />
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingRef(null)}
                      >
                        <X />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={saveEdit}
                        disabled={busy || !editText.trim()}
                      >
                        {busy ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Check />
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <span
                        className={
                          'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ' +
                          KIND_BADGE[n.kind]
                        }
                      >
                        {KIND_LABEL[n.kind]}
                      </span>
                      <p className="text-foreground">{n.content}</p>
                      <p className="text-[10px] text-muted-foreground" title={formatDateTime(n.at)}>
                        {sourceLabel(n)} · {new Date(n.at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(n)}
                        disabled={busy}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Edit note"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => retire(n)}
                        disabled={busy}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label="Retire note"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {retired.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowRetired((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showRetired ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Retired ({retired.length}) — audit trail
          </button>
          {showRetired && (
            <ul className="mt-2 space-y-1.5">
              {retired.map((n, i) => (
                <li
                  key={n.id ?? `ret-${i}`}
                  className="flex items-start justify-between gap-2 rounded-md border border-dashed border-border bg-muted/30 px-2.5 py-2 text-sm"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-muted-foreground line-through">{n.content}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {KIND_LABEL[n.kind]} · {n.retiredReason ?? 'retired'}
                      {n.retiredAt ? ` · ${new Date(n.retiredAt).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => restore(n)}
                    disabled={busy}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Restore note"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function KindSelect({ value, onChange }: { value: Kind; onChange: (k: Kind) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Kind)}
      className="rounded-md border border-input bg-background px-2 py-1 text-xs"
    >
      <option value="style">Style — voice, tone, format</option>
      <option value="relationship">Relationship — names, how you relate</option>
      <option value="correction">Correction — a standing fix</option>
    </select>
  );
}
