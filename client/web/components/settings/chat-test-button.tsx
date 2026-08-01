'use client';

/**
 * Browser-side chat test — sends a one-shot prompt down the SAME route
 * production uses and renders the reply inline, so a green result means the
 * provider + model + key triple is genuinely wired.
 *
 * One component, two call sites: agents (`/api/agents/:id/test/chat`) and chat
 * workers (`/api/ai-workers/:id/test/chat`). They were separate files whose
 * only real difference was the URL — the agents copy even said so — and the
 * duplicate drifted in the usual way, one growing a response field the other
 * did not model.
 *
 * Shows the model that actually served the call, which matters when Hugging
 * Face's `:fastest` routing or OpenRouter's per-call resolution can pick a
 * different sub-provider between runs, plus token counts for pricing maths.
 * When a route fails over, it says so: a reply served by the backup is a
 * different fact from a healthy primary, and the operator should see which.
 */

import { useState, useTransition } from 'react';
import { Loader2, MessageCircle } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiSend } from '@mantle/web-ui/api-fetch';

type ChatTestResult = {
  reply: string;
  model: string;
  adapter: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Present on the ai-workers route, which resolves a backup route too. */
  failedOver?: boolean;
};

export function ChatTestButton({ endpoint }: { endpoint: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<ChatTestResult | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Optional — a sample prompt to send"
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              try {
                setResult(await apiSend<ChatTestResult>(endpoint, 'POST', { prompt }));
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            });
          }}
        >
          {pending ? (
            <>
              <Loader2 className="animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <MessageCircle />
              Test chat
            </>
          )}
        </Button>
      </div>
      {result && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <p className="whitespace-pre-wrap">{result.reply || '(empty reply)'}</p>
          <p className="text-xs text-muted-foreground">
            {result.adapter} · model: {result.model}
            {result.tokensIn != null && ` · ${result.tokensIn}→${result.tokensOut} tokens`}
            {result.failedOver && ' · served by the BACKUP route'}
          </p>
        </div>
      )}
    </div>
  );
}
