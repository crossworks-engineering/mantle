'use client';

/**
 * Agent Studio — Phase 1 read-only overview. Left: the wiring DAG. Right: an
 * inspector that, for a selected agent, shows the ordered Model → System prompt
 * → Skills → Delegates breakdown AND the runtime-true *composed* prompt (the
 * thing no other screen surfaces). Skills show their fan-out; workers show their
 * prose. With nothing selected, the inspector shows the live health report +
 * the worker list.
 *
 * No editing yet — that's Phase 2 (prose versioning). See docs/agent-studio.md.
 */

import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Cpu,
  Sparkles,
  Star,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { StudioCanvas } from './studio-canvas';
import type {
  StudioGraph,
  StudioAgentDetail,
  StudioSkillDetail,
  StudioWorkerDetail,
} from '@/lib/studio/graph';

type Sel =
  | { kind: 'agent'; slug: string }
  | { kind: 'skill'; slug: string }
  | { kind: 'worker'; index: number }
  | null;

function parseSel(id: string | null): Sel {
  if (!id) return null;
  const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'agent') return { kind: 'agent', slug: rest };
  if (kind === 'skill') return { kind: 'skill', slug: rest };
  if (kind === 'worker') return { kind: 'worker', index: Number(rest) };
  return null;
}

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

function AgentInspector({ agent }: { agent: StudioAgentDetail }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{agent.name}</h2>
        {agent.isPersona && <Star className="size-3.5 text-amber-500" aria-hidden />}
        {!agent.enabled && <Badge variant="secondary">disabled</Badge>}
      </div>

      {/* Ordered flow: model → role → tools → delegates */}
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div><span className="text-muted-foreground">Model</span><div className="truncate font-medium">{agent.model}</div></div>
        <div><span className="text-muted-foreground">Role</span><div className="font-medium">{agent.role}</div></div>
        <div><span className="text-muted-foreground">Tools</span><div className="font-medium">{agent.toolCount}</div></div>
        <div><span className="text-muted-foreground">Delegates</span><div className="font-medium">{agent.delegateSlugs.length ? agent.delegateSlugs.join(', ') : '—'}</div></div>
      </div>

      {agent.missingSkillSlugs.length > 0 && (
        <Issues issues={agent.missingSkillSlugs.map((s) => `attached skill '${s}' is missing or disabled — silently dropped at runtime`)} />
      )}

      <Section title={`Composed prompt — what the model receives`}>
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
              <Prose text={agent.systemPrompt || '(empty)'} />
            </div>
            {agent.skillBlocks.map((b) => (
              <div key={b.slug} className="flex flex-col gap-1">
                <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                  <Sparkles className="size-3" aria-hidden /> Skill: {b.name}
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

function SkillInspector({ skill }: { skill: StudioSkillDetail }) {
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
        <Prose text={skill.instructions.trim() || '(no instructions)'} />
      </Section>
    </div>
  );
}

function WorkerInspector({ worker }: { worker: StudioWorkerDetail }) {
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
          <Prose text={worker.systemPrompt.trim() || '(empty)'} />
        </Section>
      )}
      {worker.extractionPrompt != null && (
        <Section title="Extraction prompt">
          <Prose text={worker.extractionPrompt.trim() || '(empty)'} />
        </Section>
      )}
      {worker.systemPrompt == null && worker.extractionPrompt == null && (
        <p className="text-[11px] text-muted-foreground">This worker carries no editable prose.</p>
      )}
    </div>
  );
}

function HealthAndWorkers({
  graph,
  onSelectWorker,
}: {
  graph: StudioGraph;
  onSelectWorker: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Section title="Health">
        <div className="flex flex-col gap-1.5">
          {graph.report.checks.map((c) => (
            <div key={c.key} className="flex items-start gap-2 text-[11px]">
              {c.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              )}
              <div className="flex flex-col">
                <span className="font-medium">{c.label}</span>
                <span className="text-muted-foreground">{c.detail}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title={`Workers (${graph.workers.length})`}>
        <div className="flex flex-col gap-1">
          {graph.workers.map((w, i) => (
            <button
              key={`${w.kind}:${w.name}:${i}`}
              type="button"
              onClick={() => onSelectWorker(i)}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-[11px] hover:bg-accent/60"
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
      </Section>
    </div>
  );
}

export function StudioView({ graph }: { graph: StudioGraph }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sel = parseSel(selectedId);

  const agent = sel?.kind === 'agent' ? graph.agents.find((a) => a.slug === sel.slug) : undefined;
  const skill = sel?.kind === 'skill' ? graph.skills.find((s) => s.slug === sel.slug) : undefined;
  const worker = sel?.kind === 'worker' ? graph.workers[sel.index] : undefined;
  const hasDetail = !!(agent || skill || worker);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
        <span className="text-[11px] text-muted-foreground">
          {graph.agents.length} agents · {graph.skills.length} skills · {graph.workers.length} workers
        </span>
        {graph.report.problems === 0 ? (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" aria-hidden /> all healthy
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
            <AlertTriangle className="size-3.5" aria-hidden /> {graph.report.problems} issue{graph.report.problems === 1 ? '' : 's'}
          </span>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_minmax(360px,420px)]">
        <div className="min-h-0 border-r border-border bg-muted/10">
          <StudioCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={agent || skill ? selectedId : null}
            onSelect={setSelectedId}
          />
        </div>

        <aside className="min-h-0 overflow-y-auto scrollbar-thin p-4">
          {hasDetail && (
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="mb-3 flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" aria-hidden /> overview
            </button>
          )}
          {agent ? (
            <AgentInspector agent={agent} />
          ) : skill ? (
            <SkillInspector skill={skill} />
          ) : worker ? (
            <WorkerInspector worker={worker} />
          ) : (
            <HealthAndWorkers graph={graph} onSelectWorker={(i) => setSelectedId(`worker:${i}`)} />
          )}
        </aside>
      </div>
    </div>
  );
}
