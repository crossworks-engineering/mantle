'use client';

/**
 * Agent Studio — Phase 1 read-only overview, focused ONE agent at a time. The
 * header selector picks the agent (or the Health / Workers views); the canvas
 * then shows only THAT agent's subgraph — its skills + the agents it delegates
 * to — so there are no cross-agent crossover lines to wade through. Click a
 * delegate node to flip focus onto it; click a skill node to inspect it.
 *
 * The inspector shows the focused agent's ordered Model → Role → Tools →
 * Delegates breakdown AND the runtime-true *composed* prompt (the thing no other
 * screen surfaces). No editing yet — that's Phase 2. See docs/agent-studio.md.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ChevronLeft, Cpu, Sparkles, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ProseEditor } from './prose-editor';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StudioCanvas } from './studio-canvas';
import type {
  StudioGraph,
  StudioAgentDetail,
  StudioSkillDetail,
  StudioWorkerDetail,
} from '@/lib/studio/graph';

function Prose({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
      {text}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function Issues({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
      {issues.map((i) => (
        <div key={i} className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{i}</span>
        </div>
      ))}
    </div>
  );
}

function AgentInspector({ agent, onSaved }: { agent: StudioAgentDetail; onSaved: () => void }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{agent.name}</h2>
        {agent.isPersona && <Star className="size-3.5 text-amber-500" aria-hidden />}
        {!agent.enabled && <Badge variant="secondary">disabled</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div><span className="text-muted-foreground">Model</span><div className="truncate font-medium">{agent.model}</div></div>
        <div><span className="text-muted-foreground">Role</span><div className="font-medium">{agent.role}</div></div>
        <div><span className="text-muted-foreground">Tools</span><div className="font-medium">{agent.toolCount}</div></div>
        <div><span className="text-muted-foreground">Delegates</span><div className="font-medium">{agent.delegateSlugs.length ? agent.delegateSlugs.join(', ') : '—'}</div></div>
      </div>

      {agent.missingSkillSlugs.length > 0 && (
        <Issues issues={agent.missingSkillSlugs.map((s) => `attached skill '${s}' is missing or disabled — silently dropped at runtime`)} />
      )}

      <Section title="Composed prompt — what the model receives">
        <p className="text-[11px] text-muted-foreground">
          A per-turn time / locale line is prepended at runtime (not shown). Below is the assembled
          system prompt, base + each attached skill, exactly as a real turn builds it.
        </p>
        <button
          type="button"
          onClick={() => setRaw((v) => !v)}
          className="self-start text-[11px] font-medium text-primary hover:underline"
        >
          {raw ? '← labeled view' : 'view raw assembled →'}
        </button>
        {raw ? (
          <Prose text={agent.composedPrompt} />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">System prompt</p>
              <ProseEditor
                entityType="agent"
                entityId={agent.id}
                field="system_prompt"
                value={agent.systemPrompt}
                onSaved={onSaved}
              />
            </div>
            {agent.skillBlocks.map((b) => (
              <div key={b.slug} className="flex flex-col gap-1">
                <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                  <Sparkles className="size-3" aria-hidden /> Skill: {b.name}
                  <span className="ml-1 normal-case tracking-normal text-muted-foreground/60">(edit on the skill)</span>
                </p>
                <Prose text={b.instructions.trim() || '(no instructions — contributes nothing)'} />
              </div>
            ))}
            {agent.skillBlocks.length === 0 && (
              <p className="text-[11px] text-muted-foreground">No skills attached.</p>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

function SkillInspector({ skill, onSaved }: { skill: StudioSkillDetail; onSaved: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{skill.name}</h2>
        {!skill.enabled && <Badge variant="secondary">disabled</Badge>}
      </div>
      <Section title={`Used by ${skill.usedByAgentSlugs.length} agent${skill.usedByAgentSlugs.length === 1 ? '' : 's'}`}>
        {skill.usedByAgentSlugs.length ? (
          <div className="flex flex-wrap gap-1.5">
            {skill.usedByAgentSlugs.map((a) => (
              <Badge key={a} variant="outline">{a}</Badge>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">Not attached to any agent.</p>
        )}
      </Section>
      {skill.toolSlugs.length > 0 && (
        <Section title="Bundles tools">
          <div className="flex flex-wrap gap-1.5">
            {skill.toolSlugs.map((t) => (
              <Badge key={t} variant="secondary" className="font-mono text-[10px]">{t}</Badge>
            ))}
          </div>
        </Section>
      )}
      <Section title="Instructions">
        <ProseEditor
          entityType="skill"
          entityId={skill.id}
          field="instructions"
          value={skill.instructions}
          onSaved={onSaved}
        />
      </Section>
    </div>
  );
}

function WorkerInspector({ worker, onSaved }: { worker: StudioWorkerDetail; onSaved: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Cpu className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{worker.name}</h2>
        {worker.isDefault && <Badge variant="outline">default</Badge>}
        {!worker.enabled && <Badge variant="secondary">disabled</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div><span className="text-muted-foreground">Kind</span><div className="font-medium">{worker.kind}</div></div>
        <div><span className="text-muted-foreground">Model</span><div className="truncate font-medium">{worker.model}</div></div>
      </div>
      <Issues issues={worker.issues} />
      {worker.systemPrompt != null && (
        <Section title="System prompt">
          <ProseEditor
            entityType="worker"
            entityId={worker.id}
            field="system_prompt"
            value={worker.systemPrompt}
            onSaved={onSaved}
          />
        </Section>
      )}
      {worker.extractionPrompt != null && (
        <Section title="Extraction prompt">
          <ProseEditor
            entityType="worker"
            entityId={worker.id}
            field="extraction_prompt"
            value={worker.extractionPrompt}
            onSaved={onSaved}
          />
        </Section>
      )}
      {worker.systemPrompt == null && worker.extractionPrompt == null && (
        <p className="text-[11px] text-muted-foreground">This worker carries no editable prose.</p>
      )}
    </div>
  );
}

function HealthReport({ graph }: { graph: StudioGraph }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-1.5 p-6">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        System health — the config-integrity checks
      </p>
      {graph.report.checks.map((c) => (
        <div key={c.key} className="flex items-start gap-2 rounded-md border border-border p-2.5 text-[11px]">
          {c.ok ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          )}
          <div className="flex flex-col">
            <span className="font-medium">{c.label}</span>
            <span className="text-muted-foreground">{c.detail}</span>
            {c.samples?.map((s) => (
              <span key={s.id} className="mt-0.5 text-destructive">· {s.id}: {s.detail}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function StudioView({ graph }: { graph: StudioGraph }) {
  const router = useRouter();
  // After a prose edit, re-fetch the server-computed graph so the composed-prompt
  // preview re-assembles live. Client selection state survives the soft refresh.
  const onSaved = () => router.refresh();
  const personaSlug = graph.agents.find((a) => a.isPersona)?.slug ?? graph.agents[0]?.slug ?? '';
  const [selection, setSelection] = useState<string>(`agent:${personaSlug}`);
  const [inspectedSkill, setInspectedSkill] = useState<string | null>(null);
  const [workerIndex, setWorkerIndex] = useState<number | null>(null);

  const isAgent = selection.startsWith('agent:');
  const focusedSlug = isAgent ? selection.slice('agent:'.length) : null;
  const viewMode = isAgent ? 'agent' : selection.slice('view:'.length); // 'agent' | 'health' | 'workers'
  const focusedAgent = focusedSlug ? graph.agents.find((a) => a.slug === focusedSlug) : undefined;

  // The focused agent's subgraph: the agent + its skills + the agents it
  // delegates to. Only edges that originate from the focused agent — no
  // cross-agent crossover.
  const sub = useMemo(() => {
    if (!focusedAgent) return { nodes: [], edges: [] };
    const keep = new Set<string>([`agent:${focusedAgent.slug}`]);
    for (const s of focusedAgent.skillSlugs) keep.add(`skill:${s}`);
    for (const d of focusedAgent.delegateSlugs) keep.add(`agent:${d}`);
    return {
      nodes: graph.nodes.filter((n) => keep.has(n.id)),
      edges: graph.edges.filter((e) => e.source === `agent:${focusedAgent.slug}` && keep.has(e.target)),
    };
  }, [graph, focusedAgent]);

  function changeSelection(v: string) {
    setSelection(v);
    setInspectedSkill(null);
    setWorkerIndex(null);
  }

  function onCanvasSelect(id: string) {
    if (id.startsWith('skill:')) {
      setInspectedSkill(id.slice('skill:'.length));
    } else if (id.startsWith('agent:')) {
      const slug = id.slice('agent:'.length);
      if (slug === focusedSlug) setInspectedSkill(null); // clicked the focused agent → show it
      else changeSelection(`agent:${slug}`); // a delegate → flip focus onto it
    }
  }

  const inspectedSkillDetail =
    inspectedSkill != null ? graph.skills.find((s) => s.slug === inspectedSkill) : undefined;
  const selectedWorker = workerIndex != null ? graph.workers[workerIndex] : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Select value={selection} onValueChange={changeSelection}>
            <SelectTrigger className="h-8 w-60" aria-label="Choose agent or view">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Agents</SelectLabel>
                {graph.agents.map((a) => (
                  <SelectItem key={a.slug} value={`agent:${a.slug}`}>
                    <span className="font-medium">{a.name}</span>
                    {a.isPersona && <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-500">persona</span>}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Views</SelectLabel>
                <SelectItem value="view:health">Health</SelectItem>
                <SelectItem value="view:workers">Workers</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {graph.agents.length} agents · {graph.skills.length} skills · {graph.workers.length} workers
          </span>
        </div>
        {graph.report.problems === 0 ? (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" aria-hidden /> all healthy
          </span>
        ) : (
          <button
            type="button"
            onClick={() => changeSelection('view:health')}
            className="flex items-center gap-1.5 text-[11px] font-medium text-destructive hover:underline"
          >
            <AlertTriangle className="size-3.5" aria-hidden /> {graph.report.problems} issue{graph.report.problems === 1 ? '' : 's'}
          </button>
        )}
      </header>

      {viewMode === 'health' ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <HealthReport graph={graph} />
        </div>
      ) : viewMode === 'workers' ? (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_minmax(360px,420px)]">
          <div className="min-h-0 overflow-y-auto scrollbar-thin border-r border-border p-4">
            <div className="mx-auto flex max-w-md flex-col gap-1">
              {graph.workers.map((w, i) => (
                <button
                  key={`${w.kind}:${w.name}:${i}`}
                  type="button"
                  onClick={() => setWorkerIndex(i)}
                  aria-current={workerIndex === i ? 'true' : undefined}
                  className={
                    'flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-[11px] ' +
                    (workerIndex === i ? 'border-primary bg-accent/60' : 'border-border hover:bg-accent/60')
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <span className={'size-2 rounded-full ' + (w.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40')} aria-hidden />
                    <span className="font-medium">{w.name}</span>
                    <span className="text-muted-foreground">· {w.kind}</span>
                  </span>
                  {w.isDefault && <Badge variant="outline" className="text-[9px]">default</Badge>}
                </button>
              ))}
            </div>
          </div>
          <aside className="min-h-0 overflow-y-auto scrollbar-thin p-4">
            {selectedWorker ? (
              <WorkerInspector worker={selectedWorker} onSaved={onSaved} />
            ) : (
              <p className="text-[11px] text-muted-foreground">Select a worker to see its model + prose.</p>
            )}
          </aside>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_minmax(360px,420px)]">
          <div className="min-h-0 border-r border-border bg-muted/10">
            <StudioCanvas
              nodes={sub.nodes}
              edges={sub.edges}
              selectedId={inspectedSkill ? `skill:${inspectedSkill}` : focusedSlug ? `agent:${focusedSlug}` : null}
              onSelect={onCanvasSelect}
            />
          </div>
          <aside className="min-h-0 overflow-y-auto scrollbar-thin p-4">
            {inspectedSkillDetail ? (
              <>
                <button
                  type="button"
                  onClick={() => setInspectedSkill(null)}
                  className="mb-3 flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft className="size-3.5" aria-hidden /> {focusedAgent?.name ?? 'agent'}
                </button>
                <SkillInspector skill={inspectedSkillDetail} onSaved={onSaved} />
              </>
            ) : focusedAgent ? (
              <AgentInspector agent={focusedAgent} onSaved={onSaved} />
            ) : (
              <p className="text-[11px] text-muted-foreground">No agent selected.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
