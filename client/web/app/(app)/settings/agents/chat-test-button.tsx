'use client';

/**
 * Browser-side chat test for an agent. Sends a one-shot prompt
 * through the agent's configured adapter and renders the reply
 * inline. Same code path as the production responder / web
 * /assistant — a successful test means the wiring is good
 * end-to-end (provider + model + api key triple).
 *
 * Shows the model that actually served the call (matters for HF's
 * :fastest routing, OR's per-call route resolution) plus token
 * counts so the operator can sanity-check pricing math.
 *
 * Pairs with the workers form's ChatTestButton in
 * [../ai-workers/chat-test-button.tsx](../ai-workers/chat-test-button.tsx);
 * the only functional difference is which row + adapter resolves on
 * the server side (agents vs ai_workers).
 */

import { useState, useTransition } from 'react';
import { Loader2, MessageCircle } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiSend } from '@mantle/web-ui/api-fetch';

export function AgentChatTestButton({ agentId }: { agentId: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<{
    reply: string;
    model: string;
    adapter: string;
    tokensIn: number | null;
    tokensOut: number | null;
  } | null>(null);

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
                const r = await apiSend<{
                  reply: string;
                  model: string;
                  adapter: string;
                  tokensIn: number | null;
                  tokensOut: number | null;
                }>(`/api/agents/${agentId}/test/chat`, 'POST', { prompt });
                setResult({
                  reply: r.reply,
                  model: r.model,
                  adapter: r.adapter,
                  tokensIn: r.tokensIn,
                  tokensOut: r.tokensOut,
                });
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
          </p>
        </div>
      )}
    </div>
  );
}
