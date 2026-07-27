'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Loader2, X } from 'lucide-react';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { serverUrl } from '@mantle/web-ui/runtime-env';
import { Button } from '@mantle/web-ui/ui/button';
import { useToast } from '@mantle/web-ui/ui/toast';

/**
 * Brand logo upload (Settings → Appearance), one strip per THEME VARIANT.
 * The uploaded image replaces the siteName WORDMARK in both headers (owner +
 * /team) at a fixed height, width free — never distorted, bounded by the
 * header bar like the peer name.
 *
 * Two variants, each set/cleared independently:
 *  - Light — the base logo, shown everywhere until a dark variant exists.
 *  - Dark — an optional override for dark mode (a dark-on-transparent mark
 *    goes invisible on a dark header; this is the escape hatch). Falls back
 *    to the base when unset, so one universal logo never needs two uploads.
 *
 * Each preview strip mimics the real header (h-16, the primary gradient).
 * The DARK strip is wrapped in a forced `dark` class — the theme tokens live
 * in `:root` / `.dark`, so the wrapper re-resolves every var inside to the
 * dark palette and the strip is truthful in either app mode. The reverse
 * (forcing LIGHT while the app is dark) is not expressible — no theme ships a
 * `.light` block — so the light strip simply follows the app mode, as the
 * single preview always did.
 *
 * Reads live state from the shared ['shell'] query and invalidates it on
 * change, so the actual header above updates the moment an upload lands.
 *
 * Accepts SVG/PNG/JPEG/WebP up to 512KB; the server validates the BYTES
 * (magic numbers, an active-content guard for SVG) — the accept attr is
 * only the file picker's filter.
 */
const MAX_BYTES = 512 * 1024;

type ShellBrand = {
  siteName: string | null;
  logoVersion: string | null;
  logoDarkVersion?: string | null;
};

export function LogoControl() {
  const shell = useQuery({
    queryKey: ['shell'],
    queryFn: () => apiFetch<ShellBrand>('/api/shell'),
  });
  const wordmark = shell.data?.siteName || 'mantle';
  const base = shell.data?.logoVersion ?? null;
  const dark = shell.data?.logoDarkVersion ?? null;

  return (
    <div className="space-y-4">
      <VariantControl
        variant="light"
        label="Light mode"
        version={base}
        // No dark logo ⇒ the base serves dark mode too; say so where the
        // user is looking instead of making them discover the fallback.
        hint={base && !dark ? 'also used in dark mode until a dark logo is set' : null}
        wordmark={wordmark}
      />
      <VariantControl
        variant="dark"
        label="Dark mode"
        version={dark}
        fallbackVersion={base}
        hint={!dark && base ? 'showing the light logo — upload to override' : null}
        wordmark={wordmark}
      />
      <p className="text-xs text-muted-foreground">
        SVG, PNG, JPEG or WebP · under 512KB · shown at header height, width scales.
      </p>
    </div>
  );
}

function VariantControl({
  variant,
  label,
  version,
  fallbackVersion = null,
  hint,
  wordmark,
}: {
  variant: 'light' | 'dark';
  label: string;
  /** This variant's own cache-busting version, or null when unset. */
  version: string | null;
  /** What the header actually falls back to — the dark strip previews the
   *  BASE logo when no dark variant exists, exactly what dark mode shows. */
  fallbackVersion?: string | null;
  hint: string | null;
  wordmark: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);

  const qs = variant === 'dark' ? '?variant=dark' : '';
  const shownSrc = version
    ? serverUrl(`/api/appearance/logo${qs ? `${qs}&` : '?'}v=${version}`)
    : fallbackVersion
      ? serverUrl(`/api/appearance/logo?v=${fallbackVersion}`)
      : null;

  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error('That file is over 512KB — export a smaller logo.');
      return;
    }
    setBusy('upload');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiFetch(`/api/profile/logo${qs}`, { method: 'PUT', body: fd });
      await queryClient.invalidateQueries({ queryKey: ['shell'] });
      toast.success(
        variant === 'dark'
          ? 'Dark-mode logo updated.'
          : 'Logo updated — both headers now carry it.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed — try again.');
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      await apiSend(`/api/profile/logo${qs}`, 'DELETE');
      await queryClient.invalidateQueries({ queryKey: ['shell'] });
      toast.success(
        variant === 'dark'
          ? 'Dark-mode logo removed — dark mode falls back to the light logo.'
          : 'Logo removed — the wordmark is back.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the logo.');
    } finally {
      setBusy(null);
    }
  };

  const strip = (
    <div className="flex h-16 items-center rounded-lg border border-border bg-gradient-to-b from-primary/10 to-background px-4">
      {shownSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shownSrc} alt={wordmark} className="h-10 w-auto max-w-full object-contain" />
      ) : (
        <span
          className="text-2xl text-primary-ink"
          style={{ fontFamily: 'var(--font-wordmark, var(--font-logo))' }}
        >
          {wordmark}
        </span>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {hint && <span className="text-xs text-muted-foreground/70">{hint}</span>}
      </div>
      {variant === 'dark' ? <div className="dark">{strip}</div> : strip}

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/svg+xml,image/png,image/jpeg,image/webp,.svg"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => inputRef.current?.click()}
        >
          {busy === 'upload' ? <Loader2 className="animate-spin" /> : <ImageUp />}
          {version ? 'Replace' : 'Upload'}
        </Button>
        {version && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={busy !== null}
            onClick={() => void remove()}
          >
            {busy === 'remove' ? <Loader2 className="animate-spin" /> : <X />}
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
