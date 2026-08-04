'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Anchor, Bot, KeyRound, Plus, Trash2, Users } from 'lucide-react';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { cn } from '@mantle/web-ui/lib/utils';
import { Badge } from '@mantle/web-ui/ui/badge';
import { Button } from '@mantle/web-ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mantle/web-ui/ui/dialog';
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
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { FieldHint, hintId } from '@mantle/web-ui/ui/field-hint';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { useToast } from '@mantle/web-ui/ui/toast';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';

type UserRow = {
  id: string;
  email: string;
  displayName: string | null;
  isOwner: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** This login's personal assistant, or null when it shares the brain default. */
  agent: { id: string; slug: string; name: string } | null;
};

/** One option in the "copy from" picker. */
type SourceAgent = { id: string; slug: string; name: string; role: string; model: string };

/**
 * Agents a personal assistant can be copied from: the brain's ENTRY-POINT
 * agents only (role assistant/responder), highest priority first — so the
 * canonical persona is the default pick.
 *
 * Specialists (role `custom`: researcher, appsmith, …) are deliberately absent.
 * They're delegation targets, not chat entry points, and only responder/assistant
 * rows get the manifest's persona convergence on upgrade
 * (`reconcilePersonaCapabilitiesByRole`) and new specialists wired into their
 * delegation (`wireDelegation`) — a `custom` clone would quietly drift.
 */
function useSourceAgents() {
  return useQuery({
    queryKey: ['users', 'source-agents'],
    queryFn: async () => {
      const { agents } = await apiFetch<{ agents: SourceAgent[] }>('/api/agents');
      return agents.filter((a) => a.role === 'assistant' || a.role === 'responder');
    },
  });
}

/**
 * Co-admin logins into the one brain — NOT tenants. Everyone sees the same data
 * and is a full admin; a row here is a login identity for the audit trail. The
 * server enforces the invariants (anchor undeletable, no self-delete); the UI
 * just mirrors them. (Access tiers are a separate team-member surface.)
 */
export function UsersClient() {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => apiFetch<{ users: UserRow[]; currentActorId: string }>('/api/users'),
  });

  // Deep link: /settings/users?selected=<id-or-email> preselects that user
  // (initial state only — selection stays client-state after).
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('selected'));
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  if (usersQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (usersQuery.isError && !usersQuery.data) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
        <p>Couldn&apos;t load logins.</p>
        <Button variant="outline" size="sm" onClick={() => usersQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const { users, currentActorId } = usersQuery.data;
  const selected =
    users.find((u) => u.id === selectedId || u.email === selectedId) ?? users[0] ?? null;

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* LEFT: login list */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Logins
          </h2>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus /> Add login
          </Button>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => setSelectedId(u.id)}
              className={cn(
                'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                selected?.id === u.id && 'border-l-primary',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {u.displayName || u.email}
                </span>
                {u.agent && (
                  <Badge variant="outline" className="shrink-0" title={u.agent.name}>
                    <Bot className="size-3" /> {u.agent.name}
                  </Badge>
                )}
                {u.isOwner && (
                  <Badge variant="secondary" className="shrink-0">
                    Anchor
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {u.displayName
                  ? u.email
                  : u.lastLoginAt
                    ? `Last login ${formatDateTime(u.lastLoginAt)}`
                    : 'Never signed in'}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* RIGHT: detail */}
      <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <UserDetail
            key={selected.id}
            user={selected}
            isSelf={selected.id === currentActorId}
            onChanged={invalidate}
            onRequestDelete={() => setDeleteOpen(true)}
            onRequestReset={() => setResetOpen(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            <Users className="mr-2 size-4" /> No logins.
          </div>
        )}
      </div>

      <AddUserDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(id) => {
          setSelectedId(id);
          void invalidate();
        }}
      />
      {selected && (
        <>
          <ResetPasswordDialog open={resetOpen} onOpenChange={setResetOpen} user={selected} />
          <DeleteUserDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            user={selected}
            onDeleted={() => {
              setSelectedId(null);
              void invalidate();
            }}
          />
        </>
      )}
    </div>
  );
}

function UserDetail({
  user,
  isSelf,
  onChanged,
  onRequestDelete,
  onRequestReset,
}: {
  user: UserRow;
  isSelf: boolean;
  onChanged: () => void;
  onRequestDelete: () => void;
  onRequestReset: () => void;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [saving, setSaving] = useState(false);

  const saveDisplayName = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiSend(`/api/users/${user.id}`, 'PATCH', {
        displayName: displayName.trim() || null,
      });
      onChanged();
      toast.success('User saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{user.displayName || user.email}</h2>
            {user.isOwner && (
              <Badge variant="secondary">
                <Anchor className="size-3" /> Anchor
              </Badge>
            )}
            {isSelf && <Badge variant="outline">You</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            {user.isOwner
              ? 'The anchor login. The brain is keyed to it, so it can’t be deleted.'
              : 'Another way into this brain. Same brain, same data, same settings — actions are recorded under this identity.'}
          </p>
        </div>
        {!user.isOwner && !isSelf && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-destructive-ink"
            onClick={onRequestDelete}
            aria-label="Delete user"
          >
            <Trash2 />
          </Button>
        )}
      </div>

      <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Email</div>
          <div className="mt-0.5">{user.email}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Created</div>
          <div className="mt-0.5">{formatDateTime(user.createdAt)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Last login</div>
          <div className="mt-0.5">
            {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never signed in'}
          </div>
        </div>
      </div>

      <form onSubmit={saveDisplayName} className="max-w-md space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="display-name">Display name</Label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Ronnie van Zyl"
            aria-describedby={hintId('display-name')}
          />
          <FieldHint id="display-name">
            How this person appears in the app. Changing it doesn&apos;t affect their login.
          </FieldHint>
        </div>
        <SubmitButton pending={saving}>Save user</SubmitButton>
      </form>

      <AssistantCard user={user} onChanged={onChanged} />

      <div className="max-w-md rounded-md border border-border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="size-4 text-muted-foreground" /> Password
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Set a new password for this login. The reset is recorded in the audit log.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onRequestReset}>
            Reset password
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A login's personal assistant: create it, rename it, or release it.
 *
 * Releasing only drops the binding — the agent and its whole chat history stay,
 * as an ordinary shared agent under /settings/agents. Nothing here ever deletes
 * an agent; that stays a deliberate act on the agents screen.
 */
function AssistantCard({ user, onChanged }: { user: UserRow; onChanged: () => void }) {
  const toast = useToast();
  const sources = useSourceAgents();
  const [name, setName] = useState(user.agent?.name ?? '');
  const [sourceAgentId, setSourceAgentId] = useState('');
  const [pending, setPending] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Enter a name for the assistant.');
      return;
    }
    // With an assistant already in place and no explicit new source, this is a
    // rename — the server keeps the slug, so the existing thread survives.
    const source = user.agent ? sourceAgentId || undefined : sourceAgentId || sources.data?.[0]?.id;
    if (!user.agent && !source) {
      toast.error('No agent available to copy from.');
      return;
    }
    setPending(true);
    try {
      await apiSend(`/api/users/${user.id}/agent`, 'PUT', {
        name: trimmed,
        ...(source ? { sourceAgentId: source } : {}),
      });
      setSourceAgentId('');
      onChanged();
      toast.success(user.agent ? 'Assistant renamed' : 'Assistant created');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the assistant');
    } finally {
      setPending(false);
    }
  };

  const release = async () => {
    setPending(true);
    try {
      await apiSend(`/api/users/${user.id}/agent`, 'DELETE');
      setName('');
      setReleaseOpen(false);
      onChanged();
      toast.success('Assistant released');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not release the assistant');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="max-w-md space-y-3 rounded-md border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bot className="size-4 text-muted-foreground" /> Assistant
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {user.agent ? (
              <>
                Chats open on{' '}
                <a
                  href={`/settings/agents?selected=${user.agent.id}`}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {user.agent.name}
                </a>{' '}
                for this login, on its own thread.
              </>
            ) : (
              'Shares the brain’s default assistant — chats land in the same thread as everyone else’s.'
            )}
          </p>
        </div>
        {user.agent && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setReleaseOpen(true)}
          >
            Release
          </Button>
        )}
      </div>
      <form onSubmit={save} className="space-y-3">
        <AssistantFields
          idPrefix={`user-${user.id}`}
          name={name}
          onNameChange={setName}
          sourceAgentId={sourceAgentId}
          onSourceAgentIdChange={setSourceAgentId}
          sources={sources.data ?? []}
          nameLabel="Assistant name"
          showSource={!user.agent}
          nameHint={
            user.agent
              ? 'Renaming keeps the same assistant and its chat history. To copy from a different agent, release this one and create a new one.'
              : undefined
          }
        />
        <SubmitButton pending={pending}>
          {user.agent ? 'Rename assistant' : 'Create assistant'}
        </SubmitButton>
      </form>

      <AlertDialog open={releaseOpen} onOpenChange={setReleaseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release {user.agent?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops being this login&apos;s assistant, so a fresh sign-in lands on the
              brain&apos;s default instead. Someone already chatting to it keeps their place until
              they pick another agent. The agent and its whole chat history stay — it becomes an
              ordinary shared agent, and you can delete it from Settings → Agents if you want it
              gone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                void release();
              }}
            >
              Release assistant
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Name + source-agent inputs for a login's personal assistant. Shared by the
 * Add-login dialog and the detail panel's assistant card, so the wording of
 * what this does — and what it does NOT do — is written once.
 */
function AssistantFields({
  idPrefix,
  name,
  onNameChange,
  sourceAgentId,
  onSourceAgentIdChange,
  sources,
  nameLabel = 'Assistant name (optional)',
  nameHint,
  showSource = true,
}: {
  idPrefix: string;
  name: string;
  onNameChange: (v: string) => void;
  sourceAgentId: string;
  onSourceAgentIdChange: (v: string) => void;
  sources: SourceAgent[];
  nameLabel?: string;
  nameHint?: React.ReactNode;
  /** False once an assistant exists — then the only in-place edit is a rename,
   *  which keeps the slug and therefore the thread. Pointing a login at a
   *  different source is Release + Create, so nobody strands a live thread by
   *  nudging a dropdown. */
  showSource?: boolean;
}) {
  const nameId = `${idPrefix}-agent-name`;
  const sourceId = `${idPrefix}-agent-source`;
  const selected = sourceAgentId || sources[0]?.id || '';
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>{nameLabel}</Label>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Nova"
          aria-describedby={hintId(nameId)}
        />
        <FieldHint
          id={nameId}
          warn="Not private: every login can still open this assistant and read its chat."
        >
          {nameHint ?? (
            <>
              Gives this login its own copy of an assistant, so their chat is a separate
              conversation instead of sharing one thread with everyone else. Leave blank to share
              the brain&apos;s default assistant.
            </>
          )}
        </FieldHint>
      </div>
      {showSource && name.trim().length > 0 && (
        <div className="space-y-1.5">
          <Label htmlFor={sourceId}>Copy from</Label>
          <Select value={selected} onValueChange={onSourceAgentIdChange}>
            <SelectTrigger id={sourceId} aria-describedby={hintId(sourceId)}>
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {sources.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span className="font-medium">{a.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {a.model.split('/').pop()}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldHint id={sourceId}>
            The copy keeps its source&apos;s model, prompt, skills and tools, but answers to the
            name you give it here — it just gets its own chat history. Telegram bots and learned
            persona notes aren&apos;t copied.
          </FieldHint>
        </div>
      )}
    </>
  );
}

function AddUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [sourceAgentId, setSourceAgentId] = useState('');
  const [pending, setPending] = useState(false);
  const sources = useSourceAgents();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      // A blank assistant name means "share the brain default", exactly as every
      // login behaved before per-login assistants existed.
      const wantsAgent = agentName.trim().length > 0;
      const source = sourceAgentId || sources.data?.[0]?.id;
      if (wantsAgent && !source) {
        toast.error('No agent available to copy from.');
        return;
      }
      const res = await apiSend<{ id: string; agentError: string | null }>('/api/users', 'POST', {
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
        ...(wantsAgent ? { agent: { name: agentName.trim(), sourceAgentId: source } } : {}),
      });
      if (res.agentError) toast.error(res.agentError);
      else toast.success(wantsAgent ? 'Login and assistant added' : 'User added');
      setEmail('');
      setPassword('');
      setDisplayName('');
      setAgentName('');
      setSourceAgentId('');
      onOpenChange(false);
      onCreated(res.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add user');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add login</DialogTitle>
          <DialogDescription>
            Another way into this brain — same data, same settings, no separate account. Share the
            starting password; it can be changed after signing in.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-user-email">Email</Label>
            <Input
              id="new-user-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              autoComplete="off"
              aria-describedby={hintId('new-user-email')}
            />
            <FieldHint id="new-user-email">
              Their login. It can&apos;t be changed afterwards.
            </FieldHint>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-password">Starting password</Label>
            <Input
              id="new-user-password"
              type="text"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="off"
              aria-describedby={hintId('new-user-password')}
            />
            <FieldHint
              id="new-user-password"
              warn="You'll need to pass this to them yourself — it isn't emailed."
            >
              What they sign in with the first time.
            </FieldHint>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-display-name">Display name (optional)</Label>
            <Input
              id="new-user-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Ronnie van Zyl"
              aria-describedby={hintId('new-user-display-name')}
            />
            <FieldHint id="new-user-display-name">
              Falls back to the email address when blank.
            </FieldHint>
          </div>
          <AssistantFields
            idPrefix="new-user"
            name={agentName}
            onNameChange={setAgentName}
            sourceAgentId={sourceAgentId}
            onSourceAgentIdChange={setSourceAgentId}
            sources={sources.data ?? []}
          />
          <div className="flex justify-end pt-1">
            <SubmitButton pending={pending}>Add login</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserRow;
}) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await apiSend(`/api/users/${user.id}/password`, 'POST', { newPassword: password });
      toast.success(`Password reset for ${user.email}`);
      setPassword('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reset password');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a new password for {user.email}. Their current password stops working immediately;
            the reset is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="reset-password-value">New password</Label>
            <Input
              id="reset-password-value"
              type="text"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="off"
              aria-describedby={hintId('reset-password-value')}
            />
            <FieldHint
              id="reset-password-value"
              warn="Their old password stops working the moment you save."
            >
              What they&apos;ll sign in with from now on.
            </FieldHint>
          </div>
          <div className="flex justify-end pt-1">
            <SubmitButton pending={pending}>Reset password</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserDialog({
  open,
  onOpenChange,
  user,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserRow;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setPending(true);
    try {
      await apiSend(`/api/users/${user.id}`, 'DELETE');
      toast.success(`Removed ${user.email}`);
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete user');
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {user.displayName || user.email}?</AlertDialogTitle>
          <AlertDialogDescription>
            Their login stops working immediately. Nothing in the brain is removed — everything they
            created stays — and their past actions remain in the audit log.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={pending}
            onClick={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            Delete user
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
