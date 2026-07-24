'use client';

/**
 * Owner control on the Team admin sidebar: which mini-app (if any) renders as
 * the Team Hub. Designating requires a published build (enforced server-side);
 * clearing reverts members to the built-in hub. The share lifecycle note:
 * designation ensures a TEAM-mode share for the app — undesignating leaves
 * that share alone (revoke it from the app's own share controls if wanted).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutTemplate } from 'lucide-react';
import { Label } from '@mantle/web-ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiSend } from '@mantle/web-ui/api-fetch';

const BUILT_IN = '__built_in__';

export function HubAppPicker({
  currentAppId,
  apps,
}: {
  /** The designated app id, or null for the built-in hub. */
  currentAppId: string | null;
  /** The owner's PUBLISHED apps (id + title), designation candidates. */
  apps: { id: string; title: string }[];
}) {
  const [value, setValue] = useState(currentAppId ?? BUILT_IN);
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const router = useRouter();

  const apply = async (next: string) => {
    const prev = value;
    setValue(next); // optimistic
    setPending(true);
    try {
      if (next === BUILT_IN) {
        await apiSend('/api/team-admin/hub-app', 'DELETE');
        toast.success('Members now see the built-in Team Hub.');
      } else {
        const res = await apiSend<{ modeChanged: boolean }>('/api/team-admin/hub-app', 'PUT', {
          appId: next,
        });
        toast.success(
          res.modeChanged
            ? 'Hub app designated. Its share link is now team-members-only.'
            : 'Hub app designated — members see it on /team.',
        );
      }
      router.refresh();
    } catch (err) {
      setValue(prev); // revert
      toast.error(err instanceof Error ? err.message : 'Could not update the hub app.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="hubApp" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LayoutTemplate className="size-3.5" aria-hidden />
        Hub app
      </Label>
      <Select value={value} onValueChange={(v) => void apply(v)} disabled={pending}>
        <SelectTrigger id="hubApp" className="h-8 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={BUILT_IN}>Built-in hub</SelectItem>
          {apps.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-snug text-muted-foreground">
        A published app rendered as the members&rsquo; hub. Falls back to the built-in hub if the
        app breaks.
      </p>
    </div>
  );
}
