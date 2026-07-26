'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Loader2, X } from 'lucide-react';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { serverUrl } from '@mantle/web-ui/runtime-env';
import { Button } from '@mantle/web-ui/ui/button';
import { useToast } from '@mantle/web-ui/ui/toast';

/**
 * Brand logo upload (Settings → Appearance). The uploaded image replaces the
 * siteName WORDMARK in both headers (owner + /team) at a fixed height, width
 * free — never distorted, bounded by the header bar like the peer name.
 *
 * The preview strip mimics the real header (h-16, the primary gradient) so
 * what you see here is what the header shows. Reads the live state from the
 * shared ['shell'] query and invalidates it on change, so the actual header
 * above updates the moment an upload lands — no reload.
 *
 * Accepts SVG/PNG/JPEG/WebP up to 512KB; the server validates the BYTES
 * (magic numbers, an active-content guard for SVG) — the accept attr is
 * only the file picker's filter.
 */
const MAX_BYTES = 512 * 1024;

export function LogoControl() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);

  const shell = useQuery({
    queryKey: ['shell'],
    queryFn: () => apiFetch<{ siteName: string | null; logoVersion: string | null }>('/api/shell'),
  });
  const logoVersion = shell.data?.logoVersion ?? null;
  const wordmark = shell.data?.siteName || 'mantle';

  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error('That file is over 512KB — export a smaller logo.');
      return;
    }
    setBusy('upload');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiFetch('/api/profile/logo', { method: 'PUT', body: fd });
      await queryClient.invalidateQueries({ queryKey: ['shell'] });
      toast.success('Logo updated — both headers now carry it.');
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
      await apiSend('/api/profile/logo', 'DELETE');
      await queryClient.invalidateQueries({ queryKey: ['shell'] });
      toast.success('Logo removed — the wordmark is back.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the logo.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      {/* Header-height preview strip — the logo exactly as the header shows it. */}
      <div className="flex h-16 items-center rounded-lg border border-border bg-gradient-to-b from-primary/10 to-background px-4">
        {logoVersion ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={serverUrl(`/api/appearance/logo?v=${logoVersion}`)}
            alt={wordmark}
            className="h-10 w-auto max-w-full object-contain"
          />
        ) : (
          <span
            className="text-2xl text-primary"
            style={{ fontFamily: 'var(--font-wordmark, var(--font-logo))' }}
          >
            {wordmark}
          </span>
        )}
      </div>

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
          {logoVersion ? 'Replace logo' : 'Upload logo'}
        </Button>
        {logoVersion && (
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
      <p className="text-xs text-muted-foreground">
        SVG, PNG, JPEG or WebP · under 512KB · shown at header height, width scales.
      </p>
    </div>
  );
}
