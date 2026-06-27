'use client';

/**
 * Agent Studio Phase 3 — structure editing (docs/agent-studio.md). Rewire an
 * agent's graph from the inspector: swap its model, tune params, attach/detach
 * skills, add/remove delegates, and reset a manifest agent to its canonical
 * default. Every change PATCHes the agent and calls onSaved → refetch the studio
 * graph, so the integrity health overlay + composed-prompt preview relight live.
 */

import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, RotateCcw } from 'lucide-react';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ModelSelect } from '@/components/ui/model-select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { ExplorerModel } from '@/lib/model-explorer';

export type SkillOpt = { slug: string; name: string; usedByAgentSlugs: string[] };
export type AgentOpt = { slug: string; name: string; enabled: boolean };

type AgentLike = {
  id: string;
  slug: string;
  name: string;
  model: string;
  params: { temperature?: number; max_tokens?: number };
  maxIterations?: number;
  skillSlugs: string[];
  delegateSlugs: string[];
  resettable: boolean;
};

function ToggleRow({
  on,
  label,
  hint,
  disabled,
  onClick,
}: {
  on: boolean;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-accent/60 disabled:opacity-50"
    >
      <span className="flex items-center gap-1.5">
        <span
          className={
            'flex size-3.5 shrink-0 items-center justify-center rounded-sm border ' +
            (on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')
          }
        >
          {on && <Check className="size-2.5" aria-hidden />}
        </span>
        {label}
      </span>
      {hint && <span className="shrink-0 text-muted-foreground/60">{hint}</span>}
    </button>
  );
}

export function StructureEditor({
  agent,
  allSkills,
  allAgents,
  onSaved,
}: {
  agent: AgentLike;
  allSkills: SkillOpt[];
  allAgents: AgentOpt[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<ExplorerModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [temp, setTemp] = useState(agent.params.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(agent.params.max_tokens?.toString() ?? '');
  const [maxIter, setMaxIter] = useState(agent.maxIterations?.toString() ?? '');

  useEffect(() => {
    if (!open || catalog.length || catalogLoading) return;
    setCatalogLoading(true);
    apiFetch<{ models?: ExplorerModel[] }>('/api/model-context')
      .then((d) => setCatalog(d.models ?? []))
      .catch(() => {})
      .finally(() => setCatalogLoading(false));
  }, [open, catalog.length, catalogLoading]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiSend(`/api/agents/${agent.id}`, 'PATCH', body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleSkill(slug: string) {
    const set = new Set(agent.skillSlugs);
    set.has(slug) ? set.delete(slug) : set.add(slug);
    void patch({ skillSlugs: [...set] });
  }

  function toggleDelegate(slug: string) {
    const set = new Set(agent.delegateSlugs);
    set.has(slug) ? set.delete(slug) : set.add(slug);
    void patch({ memoryConfig: { delegate_to: [...set] } });
  }

  function saveParams() {
    const params: Record<string, number> = {};
    if (temp.trim()) params.temperature = Number(temp);
    if (maxTokens.trim()) params.max_tokens = Number(maxTokens);
    const body: Record<string, unknown> = { params };
    if (maxIter.trim()) body.memoryConfig = { max_iterations: Number(maxIter) };
    void patch(body);
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      await apiSend('/api/studio/reset', 'POST', { slug: agent.slug });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className="size-3.5" aria-hidden /> Edit structure — model · params · skills · delegates
      </button>
    );
  }

  const skillSet = new Set(agent.skillSlugs);
  const delegateSet = new Set(agent.delegateSlugs);
  const delegateCandidates = allAgents.filter((a) => a.enabled && a.slug !== agent.slug);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="flex items-center gap-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className="size-3.5" aria-hidden /> Structure
        {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
      </button>
      {error && <p className="text-[13px] text-destructive">{error}</p>}

      <div className="flex flex-col gap-1">
        <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground/80">Model</p>
        <ModelSelect
          value={agent.model}
          models={catalog}
          loading={catalogLoading}
          onValueChange={(m) => void patch({ model: m })}
        />
        <p className="text-[12px] text-muted-foreground/70">Provider + API key stay as configured — change those in Settings → Agents.</p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground/80">Params</p>
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
            temperature
            <Input type="number" step="0.1" min="0" max="2" value={temp} disabled={busy} onChange={(e) => setTemp(e.target.value)} onBlur={saveParams} className="h-7 text-sm" />
          </label>
          <label className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
            max tokens
            <Input type="number" min="1" value={maxTokens} disabled={busy} onChange={(e) => setMaxTokens(e.target.value)} onBlur={saveParams} className="h-7 text-sm" />
          </label>
          <label className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
            max iters
            <Input type="number" min="1" max="100" value={maxIter} disabled={busy} onChange={(e) => setMaxIter(e.target.value)} onBlur={saveParams} className="h-7 text-sm" />
          </label>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground/80">Skills</p>
        <div className="flex flex-col gap-0.5">
          {allSkills.map((s) => (
            <ToggleRow
              key={s.slug}
              on={skillSet.has(s.slug)}
              label={s.name}
              hint={`${s.usedByAgentSlugs.length} agent${s.usedByAgentSlugs.length === 1 ? '' : 's'}`}
              disabled={busy}
              onClick={() => toggleSkill(s.slug)}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground/80">Delegates to</p>
        <div className="flex flex-col gap-0.5">
          {delegateCandidates.map((a) => (
            <ToggleRow
              key={a.slug}
              on={delegateSet.has(a.slug)}
              label={a.name}
              disabled={busy}
              onClick={() => toggleDelegate(a.slug)}
            />
          ))}
          {delegateCandidates.length === 0 && (
            <p className="px-1.5 text-[13px] text-muted-foreground">No other enabled agents to delegate to.</p>
          )}
        </div>
      </div>

      {agent.resettable && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost" className="self-start text-[13px] text-destructive hover:text-destructive" disabled={busy}>
              <RotateCcw className="size-3" /> Reset to default
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset {agent.name} to its default?</AlertDialogTitle>
              <AlertDialogDescription>
                This overwrites the system prompt, model, params, skills and delegation with the
                canonical manifest definition. Studio edits to this agent — including saved prompt
                versions’ live value — will be replaced (the version history is kept).
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void reset()}>Reset</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
