'use client';

/**
 * Browser-side vision preview. The operator picks an image from disk
 * (JPEG/PNG/WebP/GIF), we base64-encode it and hand it to the
 * `testVisionAction` server action, then render the extracted text.
 *
 * This is the visual analogue of the SttTestButton — same "see what
 * the worker actually produces" sanity check, just for image input.
 *
 * UI affordances:
 *   - File input restricted to image/* (browsers enforce the picker
 *     filter; we still validate type server-side via the adapter's
 *     allowed-MIME list).
 *   - Thumbnail preview of the chosen image so the operator can
 *     confirm they picked the right file before sending.
 *   - Loading state during the extraction (vision calls take 5–20s
 *     for a high-res photo on Sonnet/4o).
 *   - Result rendered in a monospace block so whitespace + indentation
 *     in transcripts is preserved.
 */

import { useRef, useState, useTransition } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiSend } from '@/lib/api-fetch';

export function VisionTestButton({ workerId }: { workerId: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<{
    text: string;
    model: string;
    adapter: string;
    tokensIn: number | null;
    tokensOut: number | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onFile = (f: File | null) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
    setResult(null);
  };

  const run = () => {
    if (!file) return;
    startTransition(async () => {
      try {
        // FileReader gives us a base64 data URL; strip the prefix
        // before sending — the action wants raw base64.
        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve, reject) => {
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const comma = dataUrl.indexOf(',');
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
          };
          reader.onerror = () => reject(reader.error ?? new Error('read failed'));
          reader.readAsDataURL(file);
        });
        const r = await apiSend<{
          ok: true;
          text: string;
          model: string;
          adapter: string;
          tokensIn: number | null;
          tokensOut: number | null;
        }>(`/api/ai-workers/${workerId}/test/vision`, 'POST', {
          imageBase64: base64,
          mimeType: file.type || 'image/jpeg',
        });
        setResult({
          text: r.text,
          model: r.model,
          adapter: r.adapter,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
      <div className="flex items-center gap-2">
        {!file ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={pending}
          >
            <ImagePlus />
            Pick image
          </Button>
        ) : (
          <>
            <Button type="button" onClick={run} disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Extracting…
                </>
              ) : (
                <>Run extraction</>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onFile(null)}
              disabled={pending}
              title="Clear"
            >
              <X />
            </Button>
          </>
        )}
      </div>
      {previewUrl && (
        <div className="overflow-hidden rounded-md border border-border bg-muted/30">
          {/* Bounded preview so a 4K photo doesn't blow up the form. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="image preview"
            className="max-h-64 w-full object-contain"
          />
          <p className="px-3 py-1.5 text-xs text-muted-foreground">
            {file?.name} · {file?.type} · {file && (file.size / 1024).toFixed(0)} KB
          </p>
        </div>
      )}
      {result && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {result.text || '(empty result)'}
          </pre>
          <p className="text-xs text-muted-foreground">
            adapter: {result.adapter} · model: {result.model}
            {result.tokensIn != null && ` · in: ${result.tokensIn} tok`}
            {result.tokensOut != null && ` · out: ${result.tokensOut} tok`}
          </p>
        </div>
      )}
    </div>
  );
}
