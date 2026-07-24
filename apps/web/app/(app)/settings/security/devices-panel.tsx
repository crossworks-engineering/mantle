'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Smartphone, Monitor } from 'lucide-react';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
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
} from '@mantle/web-ui/ui/alert-dialog';
import { useToast } from '@mantle/web-ui/ui/toast';

type Device = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  current: boolean;
};

/**
 * Signed-in devices — every live bearer (web clients + mobile companions),
 * revocable per device. The session COOKIE isn't listed: it has no row (it's
 * stateless); password change / logout govern it.
 */
export function DevicesPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const devicesQuery = useQuery({
    queryKey: ['auth-devices'],
    queryFn: () => apiFetch<{ devices: Device[] }>('/api/auth/devices'),
  });

  async function revoke(device: Device) {
    try {
      await apiFetch(`/api/auth/devices/${device.id}`, { method: 'DELETE' });
      toast.success(`Signed out “${device.label}”.`);
      void queryClient.invalidateQueries({ queryKey: ['auth-devices'] });
    } catch {
      toast.error('Could not revoke that device.');
    }
  }

  const devices = devicesQuery.data?.devices ?? [];

  return (
    <div className="space-y-2">
      {devicesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading devices…</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No signed-in devices. Bearer sessions from the mobile companion or a detached client
          appear here.
        </p>
      ) : (
        devices.map((d) => (
          <div
            key={d.id}
            className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
          >
            {/Web client/i.test(d.label) ? (
              <Monitor className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Smartphone className="size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">
                {d.label}
                {d.current && (
                  <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground">
                    This device
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {d.lastUsedAt
                  ? `Last used ${new Date(d.lastUsedAt).toLocaleString()}`
                  : `Added ${new Date(d.createdAt).toLocaleString()}`}
                {' · '}expires {new Date(d.expiresAt).toLocaleDateString()}
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm">
                  Revoke
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Sign out “{d.label}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The device's token is revoked immediately — its next request fails and it must
                    sign in again.{d.current ? ' This is the device you are using right now.' : ''}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => void revoke(d)}
                  >
                    Revoke device
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ))
      )}
    </div>
  );
}
