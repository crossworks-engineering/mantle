'use client';

/**
 * Owner switch on the Team admin header: whether the Team Chat responder may
 * read the owner's PRIVATE corpus (email + journal) for a team member. Default
 * OFF — team members always get brain-wide knowledge reads, but personal email
 * and journal stay off-limits until the owner opts in here.
 */
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { apiSend } from '@/lib/api-fetch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function PrivateReadsToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toast = useToast();

  const persist = async (next: boolean) => {
    setEnabled(next); // optimistic
    setPending(true);
    try {
      await apiSend('/api/team-admin/settings', 'PATCH', { teamPrivateReads: next });
      toast.success(
        next
          ? 'Team members can now have email & journal read on their behalf.'
          : 'Email & journal are now off-limits to team members.',
      );
    } catch {
      setEnabled(!next); // revert
      toast.error('Could not update the setting — try again.');
    } finally {
      setPending(false);
    }
  };

  // Enabling exposes private data → confirm first. Disabling is the safe
  // direction and applies immediately.
  const onChange = (next: boolean) => {
    if (next) setConfirmOpen(true);
    else void persist(false);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor="teamPrivateReads" className="text-xs text-muted-foreground">
          Expose email &amp; journal
        </Label>
        <Switch
          id="teamPrivateReads"
          checked={enabled}
          onCheckedChange={onChange}
          disabled={pending}
          aria-label="Allow team members to read the owner's email and journal"
        />
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Expose your email &amp; journal to team members?</AlertDialogTitle>
            <AlertDialogDescription>
              Team members can already have your notes, pages, tables, files, tasks, events and
              contacts read on their behalf through the responder — the brain is the trust
              boundary. Enabling this <strong>also</strong> lets them reach your{' '}
              <strong>email history and personal journal</strong>, including anything an uploaded
              document tries to make the responder look up. Only turn this on if every team member
              is trusted with that. You can turn it off again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void persist(true)}>
              Enable private reads
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
