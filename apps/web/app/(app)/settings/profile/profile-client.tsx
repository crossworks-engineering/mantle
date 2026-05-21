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

import { useState, useTransition } from 'react';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { AvatarPicker, type AvatarValue } from '@/components/avatar-picker';
import type { ProfilePreferences } from '@mantle/content';

export function ProfileClient({
  defaults,
  defaultsFallback,
  samplePreview,
  userId,
  action,
}: {
  defaults: ProfilePreferences;
  defaultsFallback: ProfilePreferences;
  samplePreview: string;
  userId: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const toast = useToast();
  const [tz, setTz] = useState(defaults.timezone);
  const [loc, setLoc] = useState(defaults.locale);
  const [avatar, setAvatar] = useState<AvatarValue | null>(
    defaults.avatarStyle ? { style: defaults.avatarStyle, seed: defaults.avatarSeed || userId } : null,
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      try {
        await action(fd);
        toast.success('Preferences saved');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
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
          Generated with DiceBear from a style + seed. Shows in the header and
          across the app; clear it to fall back to your initials.
        </p>
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

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save preferences'}
        </Button>
      </div>
    </form>
  );
}
