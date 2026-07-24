'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Anchor, KeyRound, Plus, Trash2, Users } from 'lucide-react';
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
};

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
        <p>Couldn&apos;t load users.</p>
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
      {/* LEFT: user list */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Users
          </h2>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus /> Add user
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
            <Users className="mr-2 size-4" /> No users.
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
              ? 'The original account. The brain is keyed to it, so it can’t be deleted.'
              : 'Co-admin login into this brain. Same data as everyone; actions are recorded under this identity.'}
          </p>
        </div>
        {!user.isOwner && !isSelf && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-destructive"
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
          />
        </div>
        <SubmitButton pending={saving}>Save user</SubmitButton>
      </form>

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
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      const res = await apiSend<{ id: string }>('/api/users', 'POST', {
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
      });
      toast.success('User added');
      setEmail('');
      setPassword('');
      setDisplayName('');
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
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            A co-admin login into this brain — they see the same data as you. Share the starting
            password with them; they can change it after signing in.
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
            />
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
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-display-name">Display name (optional)</Label>
            <Input
              id="new-user-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Ronnie van Zyl"
            />
          </div>
          <div className="flex justify-end pt-1">
            <SubmitButton pending={pending}>Add user</SubmitButton>
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
            />
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
