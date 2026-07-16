'use client';

/**
 * API Console sidebar — the searchable library (built-in API groups, MCP
 * tools, agent tools) plus Saved requests and History tabs.
 *
 * Search is a case-insensitive substring match over name, method, path,
 * description, and parameter names — typing `{id}` or a param name like
 * "agentSlug" finds every entry that carries it.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plug, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { API_CATALOG, API_CATALOG_COUNT } from '@/lib/dev-tools/catalog';
import {
  catalogHaystack,
  draftFromAgentTool,
  draftFromCatalog,
  draftFromMcpTool,
  draftFromSaved,
  schemaHaystack,
} from '@/lib/dev-tools/drafts';
import { emptyDraft } from '@/lib/dev-tools/storage';
import type { HistoryEntry } from '@/lib/dev-tools/types';
import { useDevTools } from './context';
import { KindBadge, MethodBadge } from './method-badge';

function Row({
  selected,
  onClick,
  children,
  title,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md border-l-2 border-l-transparent px-2 py-1 text-left text-xs hover:bg-muted/50',
        selected && 'border-l-primary bg-muted/40',
      )}
    >
      {children}
    </button>
  );
}

function GroupHeader({
  open,
  onToggle,
  label,
  count,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-semibold hover:bg-muted/50"
    >
      {open ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[10px] font-normal text-muted-foreground">{count}</span>
    </button>
  );
}

export function DevToolsSidebar() {
  const {
    collections,
    deleteSaved,
    deleteCollection,
    history,
    clearHistory,
    draft,
    replaceDraft,
    mcp,
    loadMcpTools,
    agentTools,
  } = useDevTools();

  const [filter, setFilter] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const q = filter.trim().toLowerCase();

  const toggle = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const filteredCatalog = useMemo(() => {
    if (!q) return API_CATALOG;
    return API_CATALOG.map((g) => ({
      ...g,
      endpoints: g.endpoints.filter((e) => catalogHaystack(e).includes(q)),
    })).filter((g) => g.endpoints.length > 0 || g.name.toLowerCase().includes(q));
  }, [q]);

  const mcpTools = mcp.status === 'ready' ? mcp.tools : [];
  const filteredMcp = useMemo(
    () =>
      q
        ? mcpTools.filter((t) => schemaHaystack(t.name, t.description, t.inputSchema).includes(q))
        : mcpTools,
    [mcpTools, q],
  );

  const filteredAgentTools = useMemo(
    () =>
      q
        ? agentTools.filter((t) =>
            schemaHaystack(`${t.slug} ${t.name}`, t.description, t.inputSchema).includes(q),
          )
        : agentTools,
    [agentTools, q],
  );

  const builtinAgentTools = filteredAgentTools.filter((t) => t.handler.kind === 'builtin');
  const customAgentTools = filteredAgentTools.filter((t) => t.handler.kind !== 'builtin');

  const isSelected = (sourceId: string) => draft.sourceId === sourceId;
  const searching = q !== '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-border p-2.5">
        <div className="flex items-center gap-1.5">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search calls, paths, {params}…"
            className="h-8 text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            title="New blank request"
            onClick={() => replaceDraft(emptyDraft())}
          >
            <Plus /> New
          </Button>
        </div>
      </div>

      <Tabs defaultValue="library" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-2.5 mt-2 grid h-8 grid-cols-3">
          <TabsTrigger value="library" className="text-xs">
            Library
          </TabsTrigger>
          <TabsTrigger value="saved" className="text-xs">
            Saved
          </TabsTrigger>
          <TabsTrigger value="history" className="text-xs">
            History
          </TabsTrigger>
        </TabsList>

        {/* ── Library ─────────────────────────────────────────────── */}
        <TabsContent value="library" className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
          <div className="space-y-3">
            <section>
              <h3 className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Built-in API · {API_CATALOG_COUNT}
              </h3>
              <div className="space-y-0.5">
                {filteredCatalog.map((g) => {
                  const open = searching || openGroups.has(g.id);
                  return (
                    <div key={g.id}>
                      <GroupHeader
                        open={open}
                        onToggle={() => toggle(g.id)}
                        label={g.name}
                        count={g.endpoints.length}
                      />
                      {open && (
                        <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1.5">
                          {g.endpoints.map((e) => (
                            <Row
                              key={e.id}
                              selected={isSelected(e.id)}
                              onClick={() => replaceDraft(draftFromCatalog(e))}
                              title={e.description}
                            >
                              <MethodBadge method={e.method} />
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                                {e.path.replace(/^\/api/, '')}
                              </span>
                            </Row>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <section>
              <h3 className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Built-in MCP{mcp.status === 'ready' ? ` · ${mcpTools.length}` : ''}
              </h3>
              {mcp.status === 'idle' && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-1.5 h-7 px-2 text-xs"
                  onClick={loadMcpTools}
                >
                  <Plug /> Connect MCP server
                </Button>
              )}
              {mcp.status === 'loading' && (
                <p className="px-1.5 text-xs text-muted-foreground">Booting the MCP server…</p>
              )}
              {mcp.status === 'error' && (
                <div className="space-y-1 px-1.5">
                  <p className="text-xs text-destructive">{mcp.error}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={loadMcpTools}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {mcp.status === 'ready' && (
                <div className="space-y-0.5">
                  {filteredMcp.map((t) => (
                    <Row
                      key={t.name}
                      selected={isSelected(`mcp_${t.name}`)}
                      onClick={() => replaceDraft(draftFromMcpTool(t))}
                      title={t.description}
                    >
                      <KindBadge kind="mcp" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                        {t.name}
                      </span>
                    </Row>
                  ))}
                  {filteredMcp.length === 0 && (
                    <p className="px-1.5 text-xs text-muted-foreground/60">No matches.</p>
                  )}
                </div>
              )}
            </section>

            <section>
              <h3 className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Agent tools · {agentTools.length}
              </h3>
              {customAgentTools.length > 0 && (
                <div className="space-y-0.5">
                  <p className="px-1.5 text-[10px] text-muted-foreground/70">Custom</p>
                  {customAgentTools.map((t) => (
                    <Row
                      key={t.id}
                      selected={isSelected(`tool_${t.slug}`)}
                      onClick={() => replaceDraft(draftFromAgentTool(t))}
                      title={t.description}
                    >
                      <KindBadge kind="tool" />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate font-mono text-[11px]',
                          !t.enabled && 'opacity-50 line-through',
                        )}
                      >
                        {t.slug}
                      </span>
                    </Row>
                  ))}
                </div>
              )}
              <div className="space-y-0.5">
                {customAgentTools.length > 0 && (
                  <p className="px-1.5 pt-1 text-[10px] text-muted-foreground/70">Built-in</p>
                )}
                {builtinAgentTools.map((t) => (
                  <Row
                    key={t.id}
                    selected={isSelected(`tool_${t.slug}`)}
                    onClick={() => replaceDraft(draftFromAgentTool(t))}
                    title={t.description}
                  >
                    <KindBadge kind="tool" />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate font-mono text-[11px]',
                        !t.enabled && 'opacity-50 line-through',
                      )}
                    >
                      {t.slug}
                    </span>
                  </Row>
                ))}
                {filteredAgentTools.length === 0 && (
                  <p className="px-1.5 text-xs text-muted-foreground/60">No matches.</p>
                )}
              </div>
            </section>
          </div>
        </TabsContent>

        {/* ── Saved ───────────────────────────────────────────────── */}
        <TabsContent value="saved" className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
          {collections.length === 0 ? (
            <p className="px-1.5 text-xs text-muted-foreground">
              Nothing saved yet — build a request and hit Save.
            </p>
          ) : (
            <div className="space-y-3">
              {collections.map((c) => (
                <section key={c.id}>
                  <div className="flex items-center justify-between px-1.5 pb-1">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {c.name} · {c.requests.length}
                    </h3>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 text-muted-foreground"
                      title="Delete collection"
                      onClick={() => deleteCollection(c.id)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                  <div className="space-y-0.5">
                    {c.requests
                      .filter(
                        (r) =>
                          !q ||
                          `${r.name} ${r.url} ${r.targetName} ${r.method}`
                            .toLowerCase()
                            .includes(q),
                      )
                      .map((r) => (
                        <div key={r.id} className="group flex items-center gap-1">
                          <Row selected={false} onClick={() => replaceDraft(draftFromSaved(r))}>
                            {r.kind === 'http' ? (
                              <MethodBadge method={r.method} />
                            ) : (
                              <KindBadge kind={r.kind} />
                            )}
                            <span className="min-w-0 flex-1 truncate">{r.name}</span>
                          </Row>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="invisible h-5 w-5 shrink-0 p-0 text-muted-foreground group-hover:visible"
                            title="Delete request"
                            onClick={() => deleteSaved(c.id, r.id)}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── History ─────────────────────────────────────────────── */}
        <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
          {history.length === 0 ? (
            <p className="px-1.5 text-xs text-muted-foreground">No requests yet.</p>
          ) : (
            <div className="space-y-1">
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={clearHistory}
                >
                  Clear history
                </Button>
              </div>
              {history
                .filter((h: HistoryEntry) => !q || h.label.toLowerCase().includes(q))
                .map((h) => (
                  <Row
                    key={h.id}
                    selected={false}
                    onClick={() =>
                      replaceDraft(draftFromSaved({ ...h.draft, id: h.id, savedAt: h.at }))
                    }
                  >
                    <span
                      className={cn(
                        'w-9 shrink-0 font-mono text-[10px] font-bold',
                        h.ok ? 'text-chart-2' : 'text-destructive',
                      )}
                    >
                      {h.status === 0 ? 'ERR' : h.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{h.label}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {h.durationMs}ms
                    </span>
                  </Row>
                ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
