'use client';

/**
 * Browser-side image-gen preview. The operator types a prompt, hits
 * "Generate", we route it through testImageGenAction (which uses the
 * same adapter the production tool does), and render the result
 * inline so it can be inspected before relying on the worker.
 *
 * Doesn't persist to files — that's the production tool's
 * responsibility. The test is ephemeral; we just want to see if the
 * model is configured correctly and the result looks right.
 */

import { useState, useTransition } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { testImageGenAction } from './actions';

export function ImageGenTestButton({ workerId }: { workerId: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [prompt, setPrompt] = useState(
    'A friendly cartoon robot waving hello, soft watercolor style on cream paper.',
  );
  const [result, setResult] = useState<{
    dataUrl: string;
    model: string;
    adapter: string;
    revisedPrompt: string | null;
  } | null>(null);

  const run = () => {
    const p = prompt.trim();
    if (!p) {
      toast.error('Enter a prompt first.');
      return;
    }
    startTransition(async () => {
      try {
        const r = await testImageGenAction(workerId, p);
        const dataUrl = `data:${r.mimeType};base64,${r.imageBase64}`;
        setResult({
          dataUrl,
          model: r.model,
          adapter: r.adapter,
          revisedPrompt: r.revisedPrompt,
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="image-gen-prompt">Test prompt</Label>
        <textarea
          id="image-gen-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="A close-up watercolor of a sleeping cat curled on a blue cushion."
          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        />
      </div>
      <div>
        <Button type="button" onClick={run} disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Sparkles />
              Generate
            </>
          )}
        </Button>
      </div>
      {result && (
        <div className="space-y-2 overflow-hidden rounded-md border border-border bg-muted/30">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.dataUrl}
            alt={prompt}
            className="max-h-96 w-full object-contain"
          />
          <div className="space-y-1 px-3 py-2 text-xs text-muted-foreground">
            <p>
              adapter: {result.adapter} · model: {result.model}
            </p>
            {result.revisedPrompt && result.revisedPrompt !== prompt && (
              <p>
                <span className="font-medium">Rewritten by model:</span>{' '}
                {result.revisedPrompt}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
