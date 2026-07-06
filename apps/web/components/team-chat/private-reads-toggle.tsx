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

export function PrivateReadsToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [pending, setPending] = useState(false);
  const toast = useToast();

  const onChange = async (next: boolean) => {
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

  return (
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
  );
}
