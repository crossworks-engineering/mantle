'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { Button } from '@mantle/web-ui/ui/button';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Switch } from '@mantle/web-ui/ui/switch';
import { Checkbox } from '@mantle/web-ui/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@mantle/web-ui/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mantle/web-ui/ui/dialog';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { useToast } from '@mantle/web-ui/ui/toast';
import { cn } from '@mantle/web-ui/lib/utils';
import { slugify } from '@/lib/slugify';

type WorkerGroup = {
  id: string;
  slug: string;
  name: string;
  memberSlugs: string[];
  enabled: boolean;
};
type WorkerAgentOption = { slug: string; name: string };
type Payload = { groups: WorkerGroup[]; workers: WorkerAgentOption[] };

const MAX_MEMBERS = 10;

export function WorkerGroupsClient() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const dataQuery = useQuery({
    queryKey: ['worker-groups'],
    queryFn: () => apiFetch<Payload>('/api/settings/worker-groups'),
  });
  const groups = useMemo(() => dataQuery.data?.groups ?? [], [dataQuery.data]);
  const workers = useMemo(() => dataQuery.data?.workers ?? [], [dataQuery.data]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = groups.find((g) => g.id === selectedId) ?? null;

  // Detail-form draft (name / members / enabled) for the selected group.
  const [draftName, setDraftName] = useState('');
  const [draftMembers, setDraftMembers] = useState<string[]>([]);
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<WorkerGroup | null>(null);

  // Create dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  const openGroup = (g: WorkerGroup) => {
    setSelectedId(g.id);
    setDraftName(g.name);
    setDraftMembers(g.memberSlugs);
    setDraftEnabled(g.enabled);
  };

  const createMutation = useMutation({
    mutationFn: (body: { slug: string; name: string }) =>
      apiSend<{ group: WorkerGroup }>('/api/settings/worker-groups', 'POST', body),
    onSuccess: async ({ group }) => {
      await queryClient.invalidateQueries({ queryKey: ['worker-groups'] });
      setCreateOpen(false);
      setNewName('');
      setNewSlug('');
      setSlugTouched(false);
      openGroup(group);
      toast.success(`Created ${group.name}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Create failed.'),
  });

  const saveMutation = useMutation({
    mutationFn: (vars: { id: string; body: Record<string, unknown> }) =>
      apiSend<{ group: WorkerGroup }>(`/api/settings/worker-groups/${vars.id}`, 'PATCH', vars.body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['worker-groups'] });
      toast.success('Saved worker group');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiSend(`/api/settings/worker-groups/${id}`, 'DELETE'),
    onSuccess: (_d, id) => {
      queryClient.invalidateQueries({ queryKey: ['worker-groups'] });
      if (selectedId === id) setSelectedId(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed.'),
  });

  const toggleMember = (slug: string) =>
    setDraftMembers((cur) => (cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug]));

  const submitDetail = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    saveMutation.mutate({
      id: selected.id,
      body: { name: draftName.trim(), memberSlugs: draftMembers, enabled: draftEnabled },
    });
  };

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({ slug: newSlug.trim(), name: newName.trim() });
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: group list ─────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Worker groups
          </h2>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setNewName('');
              setNewSlug('');
              setSlugTouched(false);
              setCreateOpen(true);
            }}
          >
            <Plus /> New
          </Button>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {dataQuery.isPending ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted-foreground">
              <Spinner size={28} />
              Loading worker groups…
            </div>
          ) : dataQuery.isError ? (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive">
              <p>Couldn’t load worker groups: {dataQuery.error.message}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => dataQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No worker groups yet. Click <strong>New</strong> to bundle worker agents into a panel.
            </p>
          ) : (
            groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => openGroup(g)}
                className={cn(
                  'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                  selectedId === g.id && 'border-l-primary',
                  !g.enabled && 'opacity-70',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{g.name}</span>
                  <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {g.memberSlugs.length} member{g.memberSlugs.length === 1 ? '' : 's'}
                  </span>
                  {!g.enabled && (
                    <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      off
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                  {g.slug}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right: detail form ───────────────────────────────────── */}
      <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <div className="space-y-4 p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">Edit {selected.name}</h2>
                <p className="font-mono text-xs text-muted-foreground">{selected.slug}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Switch checked={draftEnabled} onCheckedChange={setDraftEnabled} />
                  Enabled
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(selected)}
                >
                  <Trash2 /> Delete
                </Button>
              </div>
            </div>

            <form onSubmit={submitDetail} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="wg-name">Name</Label>
                <Input
                  id="wg-name"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label>Members (enabled worker agents)</Label>
                {workers.length === 0 ? (
                  <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    No enabled worker agents yet. Create one under{' '}
                    <a href="/settings/agents" className="underline hover:text-foreground">
                      Agents
                    </a>{' '}
                    (role <code>worker</code>) first.
                  </p>
                ) : (
                  <div className="space-y-1 rounded-md border border-border p-2">
                    {workers.map((w) => {
                      const checked = draftMembers.includes(w.slug);
                      const atCap = !checked && draftMembers.length >= MAX_MEMBERS;
                      return (
                        <label
                          key={w.slug}
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50',
                            atCap && 'cursor-not-allowed opacity-50',
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            disabled={atCap}
                            onCheckedChange={() => toggleMember(w.slug)}
                          />
                          <span className="truncate">{w.name}</span>
                          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                            {w.slug}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  A run step with <code>group:{selected.slug}</code> fans out into one attempt per
                  member plus a panel audit. 1–{MAX_MEMBERS} members.
                </p>
              </div>

              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <SubmitButton pending={saveMutation.isPending}>Save worker group</SubmitButton>
              </div>
            </form>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a worker group to edit, or create a new one.
          </div>
        )}
      </div>

      {/* Create dialog — slug + name; members added in the detail form. */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New worker group</DialogTitle>
            <DialogDescription>
              A named set of worker agents. The slug is immutable; add members after creating.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitCreate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="wg-new-name">Name</Label>
              <Input
                id="wg-new-name"
                value={newName}
                autoFocus
                onChange={(e) => {
                  const v = e.target.value;
                  setNewName(v);
                  if (!slugTouched)
                    setNewSlug(slugify(v, { allowUnderscore: true, maxLength: 64 }));
                }}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wg-new-slug">Slug</Label>
              <Input
                id="wg-new-slug"
                value={newSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setNewSlug(e.target.value);
                }}
                pattern="[a-z0-9_\-]+"
                maxLength={64}
                required
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={createMutation.isPending}>Create worker group</SubmitButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Runs that named this group keep their history, but new plans can no longer fan out to
              it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const g = deleteTarget;
                if (!g) return;
                setDeleteTarget(null);
                deleteMutation.mutate(g.id, {
                  onSuccess: () => toast.success(`Deleted ${g.name}`),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
