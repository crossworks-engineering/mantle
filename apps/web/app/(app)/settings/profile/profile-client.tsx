'use client';

/**
 * Profile form — controlled timezone + locale inputs with a
 * detect-from-browser convenience button.
 *
 * Both fields are free-text but we pre-populate with browser-detected
 * defaults the first time the user lands here, so the typical flow
 * is "click Detect → click Save" with zero typing. Operators with
 * unusual setups can override by typing the IANA / BCP-47 string
 * directly.
 *
 * Validation lives server-side in updateProfilePreferences (Intl
 * APIs reject garbage). The client surface accepts anything; the
 * action returns a useful error string the user sees in the form.
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Compass } from 'lucide-react';
import { SubmitButton } from '@/components/ui/submit-button';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { cn } from '@/lib/utils';
import { AvatarPicker, type AvatarValue } from '@/components/avatar-picker';
// Import the value from the browser-safe LEAF, not the @mantle/content barrel —
// the barrel pulls backup.ts (node:os) + identity-context (@mantle/db) into the
// client bundle. The type is erased, so it's safe from the barrel.
import { PURPOSE_ARCHETYPES } from '@mantle/content/onboarding-questions';
import type { ProfilePreferences } from '@mantle/content';

/** Sentinel for "no pinned responder" — Radix Select can't use an empty-string
 *  value, so we map this to '' before submitting. */
const REMINDER_AUTO = '__auto__';

/** `GET /api/profile` payload. */
type ProfileData = {
  preferences: ProfilePreferences;
  reminderAgents: { slug: string; name: string }[];
  fallback: ProfilePreferences;
  userId: string;
};

export function ProfileClient() {
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => apiFetch<ProfileData>('/api/profile'),
  });

  if (profileQuery.isPending) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (profileQuery.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center text-sm">
        <p className="text-muted-foreground">
          {profileQuery.error instanceof Error
            ? profileQuery.error.message
            : 'Failed to load profile.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => profileQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  // Inner form mounts only once data is loaded, so its useState seeds correctly.
  return <ProfileForm data={profileQuery.data} />;
}

function ProfileForm({ data }: { data: ProfileData }) {
  const { preferences: defaults, fallback: defaultsFallback, reminderAgents, userId } = data;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [tz, setTz] = useState(defaults.timezone);
  const [loc, setLoc] = useState(defaults.locale);
  const [reminderAgent, setReminderAgent] = useState(
    defaults.reminderAgentSlug ?? REMINDER_AUTO,
  );
  // Effective default is 'telegram' when unset (matches the reminder worker).
  const [reminderChannel, setReminderChannel] = useState<string>(
    defaults.reminderChannel ?? 'telegram',
  );
  const [avatar, setAvatar] = useState<AvatarValue | null>(
    defaults.avatarStyle ? { style: defaults.avatarStyle, seed: defaults.avatarSeed || userId } : null,
  );
  const [purpose, setPurpose] = useState(defaults.purpose ?? '');
  const [archetype, setArchetype] = useState(
    defaults.purposeArchetype ?? PURPOSE_ARCHETYPES[0]!.key,
  );
  // Default ON: undefined (never set) → on, matching isStreamThoughtsEnabled.
  const [streamThoughts, setStreamThoughts] = useState<boolean>(
    defaults.streamThoughts !== false,
  );
  // Switch on = 'replace' (single line); off = 'list' (stacking, default).
  const [replaceTrail, setReplaceTrail] = useState<boolean>(
    defaults.thoughtTrailMode === 'replace',
  );
  // Default ON: persist the trail so it survives refresh.
  const [persistThoughts, setPersistThoughts] = useState<boolean>(
    defaults.persistThoughts !== false,
  );
  // Per-user thinking budget (tokens). 0 = off (default). Select stores the
  // numeric token value; real thinking needs this > 0 AND the switch on.
  const [thinkingBudget, setThinkingBudget] = useState<number>(
    defaults.thinkingBudget ?? 0,
  );
  const [error, setError] = useState<string | null>(null);

  // Live "now in your settings" preview from the chosen tz/locale — same output
  // formatInProfile produced server-side, but it updates as you type.
  const samplePreview = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(loc || 'en-GB', {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: tz || 'UTC',
      }).format(new Date());
    } catch {
      return '— (check timezone/locale)';
    }
  }, [tz, loc]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiSend('/api/profile', 'PUT', body),
    onSuccess: () => {
      toast.success('Preferences saved');
      void queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const detectFromBrowser = () => {
    // Browser-side timezone is the user's OS setting — the closest
    // approximation we have to "where this person actually is."
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const detectedLoc =
      typeof navigator !== 'undefined' && navigator.language
        ? navigator.language
        : 'en-GB';
    setTz(detectedTz);
    setLoc(detectedLoc);
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    save.mutate({
      timezone: tz,
      locale: loc,
      avatarStyle: avatar?.style ?? '',
      avatarSeed: avatar?.seed ?? '',
      reminderAgentSlug: reminderAgent === REMINDER_AUTO ? '' : reminderAgent,
      reminderChannel,
      purpose,
      purposeArchetype: archetype,
      streamThoughts,
      thoughtTrailMode: replaceTrail ? 'replace' : 'list',
      persistThoughts,
      thinkingBudget,
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
        <span className="text-muted-foreground">Now in your settings:</span>{' '}
        <span className="font-medium">{samplePreview}</span>
      </div>

      <section className="space-y-2">
        <Label>Avatar</Label>
        <AvatarPicker value={avatar} onChange={setAvatar} fallbackSeed={userId} />
        <input type="hidden" name="avatarStyle" value={avatar?.style ?? ''} />
        <input type="hidden" name="avatarSeed" value={avatar?.seed ?? ''} />
        <p className="text-xs text-muted-foreground">
          A geometric avatar generated from a style + seed. Shows in the header
          and across the app; clear it to fall back to your initials.
        </p>
      </section>

      <section className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="purposeArchetype">Speciality</Label>
          <Select value={archetype} onValueChange={setArchetype}>
            <SelectTrigger id="purposeArchetype">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PURPOSE_ARCHETYPES.map((a) => (
                <SelectItem key={a.key} value={a.key}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="hidden" name="purposeArchetype" value={archetype} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="purpose">What this brain is for</Label>
          <Textarea
            id="purpose"
            name="purpose"
            rows={3}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="A sentence or two on what this brain is mainly used for."
          />
          <p className="text-xs text-muted-foreground">
            Grounds every assistant in the brain&apos;s mission — injected at the top of
            each conversation. Leave blank to clear it.
          </p>
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="timezone">Timezone (IANA)</Label>
            <button
              type="button"
              onClick={detectFromBrowser}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Compass className="h-3 w-3" />
              Detect from browser
            </button>
          </div>
          <Input
            id="timezone"
            name="timezone"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder={defaultsFallback.timezone}
            list="tz-suggestions"
          />
          <datalist id="tz-suggestions">
            <option value="UTC" />
            <option value="Africa/Johannesburg" />
            <option value="Europe/London" />
            <option value="Europe/Berlin" />
            <option value="America/New_York" />
            <option value="America/Los_Angeles" />
            <option value="Asia/Singapore" />
            <option value="Asia/Tokyo" />
            <option value="Australia/Sydney" />
          </datalist>
          <p className="text-xs text-muted-foreground">
            Any IANA timezone (e.g. <code className="font-mono">Africa/Johannesburg</code>,{' '}
            <code className="font-mono">Europe/London</code>). Invalid values are rejected on
            save.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="locale">Locale (BCP-47)</Label>
          <Input
            id="locale"
            name="locale"
            value={loc}
            onChange={(e) => setLoc(e.target.value)}
            placeholder={defaultsFallback.locale}
            list="loc-suggestions"
          />
          <datalist id="loc-suggestions">
            <option value="en-GB" />
            <option value="en-US" />
            <option value="en-ZA" />
            <option value="en-AU" />
            <option value="de-DE" />
            <option value="fr-FR" />
            <option value="es-ES" />
            <option value="pt-BR" />
            <option value="nl-NL" />
            <option value="af-ZA" />
          </datalist>
          <p className="text-xs text-muted-foreground">
            Drives date/number/currency formatting. <code className="font-mono">en-GB</code>
            renders <code className="font-mono">19/05/2026, 17:35</code>;{' '}
            <code className="font-mono">en-US</code> renders{' '}
            <code className="font-mono">5/19/2026, 5:35 PM</code>.
          </p>
        </div>
      </section>

      <section className="space-y-1.5">
        <Label htmlFor="reminderChannel">Reminder delivery</Label>
        <Select value={reminderChannel} onValueChange={setReminderChannel}>
          <SelectTrigger id="reminderChannel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="telegram">Telegram</SelectItem>
            <SelectItem value="mobile">Mobile app</SelectItem>
          </SelectContent>
        </Select>
        <input type="hidden" name="reminderChannel" value={reminderChannel} />
        <p className="text-xs text-muted-foreground">
          Where event reminders are delivered. This follows the last surface you
          messaged from automatically; set it here to override until you next
          message from the other one. A reminder set to the mobile app shows in
          your chat and pushes to enrolled devices.
        </p>
      </section>

      <section className="space-y-1.5">
        <Label htmlFor="reminderAgent">Event reminders from</Label>
        <Select value={reminderAgent} onValueChange={setReminderAgent}>
          <SelectTrigger id="reminderAgent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={REMINDER_AUTO}>
              Most recent chat (default)
            </SelectItem>
            {reminderAgents.map((a) => (
              <SelectItem key={a.slug} value={a.slug}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          type="hidden"
          name="reminderAgentSlug"
          value={reminderAgent === REMINDER_AUTO ? '' : reminderAgent}
        />
        <p className="text-xs text-muted-foreground">
          Which assistant&apos;s Telegram bot sends event reminders. Default
          uses whichever bot you last messaged; pin one (e.g. Saskia) so
          reminders always come from the same persona.
        </p>
      </section>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="streamThoughts">Live thinking &amp; streaming</Label>
          <Switch
            id="streamThoughts"
            checked={streamThoughts}
            onCheckedChange={setStreamThoughts}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Show the assistant&apos;s live &ldquo;thinking&rdquo; trail and stream the reply
          as it&apos;s written. Turn off for a static thinking indicator with the reply
          appearing all at once when it&apos;s done.
        </p>

        {/* Sub-options — only meaningful while streaming is on. */}
        <div className="ml-3 mt-2 space-y-3 border-l border-border/50 pl-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="replaceTrail" className={cn(!streamThoughts && 'opacity-50')}>
                Replace steps in place
              </Label>
              <Switch
                id="replaceTrail"
                checked={replaceTrail}
                onCheckedChange={setReplaceTrail}
                disabled={!streamThoughts}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Show only the current action, each one replacing the last. Off stacks
              completed steps in a list above the live line.
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="persistThoughts" className={cn(!streamThoughts && 'opacity-50')}>
                Keep the trail after refresh
              </Label>
              <Switch
                id="persistThoughts"
                checked={persistThoughts}
                onCheckedChange={setPersistThoughts}
                disabled={!streamThoughts}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Save the thought trail onto each reply so it&apos;s still there after a
              page reload. Off keeps it only until you refresh.
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="thinkingBudget" className={cn(!streamThoughts && 'opacity-50')}>
                Thinking budget
              </Label>
              <Select
                value={String(thinkingBudget)}
                onValueChange={(v) => setThinkingBudget(Number(v))}
                disabled={!streamThoughts}
              >
                <SelectTrigger id="thinkingBudget" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Off</SelectItem>
                  <SelectItem value="1024">Low</SelectItem>
                  <SelectItem value="4096">Medium</SelectItem>
                  <SelectItem value="16000">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              How hard the model reasons before answering. Needs live thinking on and a
              budget above Off. Off = no extra thinking.
            </p>
          </div>
        </div>
      </section>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div>
        <SubmitButton pending={save.isPending}>Save profile</SubmitButton>
      </div>
    </form>
  );
}
