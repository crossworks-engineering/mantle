'use client';

/**
 * Browser-side document preview. The operator picks a PDF from disk, we
 * base64-encode it and hand it to `testDocumentAction`, which runs the same
 * native extractDocument path the ingest pipeline uses, then render the text.
 * The analogue of VisionTestButton, for PDFs.
 */

import { useRef, useState, useTransition } from 'react';
import { FileUp, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { testDocumentAction } from './actions';

export function DocumentTestButton({ workerId }: { workerId: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{
    text: string;
    model: string;
    adapter: string;
    tokensIn: number | null;
    tokensOut: number | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const run = () => {
    if (!file) return;
    startTransition(async () => {
      try {
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
        const r = await testDocumentAction(workerId, base64);
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
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setResult(null);
        }}
      />
      <div className="flex items-center gap-2">
        {!file ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={pending}
          >
            <FileUp />
            Pick PDF
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
              onClick={() => {
                setFile(null);
                setResult(null);
              }}
              disabled={pending}
              title="Clear"
            >
              <X />
            </Button>
            <span className="truncate text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024).toFixed(0)} KB
            </span>
          </>
        )}
      </div>
      {result && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs">
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
