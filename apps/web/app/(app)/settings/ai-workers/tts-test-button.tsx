'use client';

/**
 * Browser-side TTS preview button. Calls the server action with the
 * worker id, gets back base64 mp3, plays it in an inline `<audio>`.
 *
 * Lets you confirm the saved voice + speed + model BEFORE the next
 * voice message in Telegram. Without this, the only way to test was
 * "send Saskia a voice clip and hope it sounds right."
 */

import { useState, useTransition } from 'react';
import { Play, Loader2, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { testTtsAction } from './actions';

export function TtsTestButton({ workerId }: { workerId: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [text, setText] = useState('');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Optional — sample text to speak"
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              try {
                const result = await testTtsAction(workerId, text);
                // Build a data URL from the base64 mp3. Browsers cache
                // data URLs aggressively so we don't waste a new URL
                // per click unless the audio actually changed.
                const url = `data:${result.mimeType};base64,${result.audioBase64}`;
                setAudioUrl(url);
                // Auto-play the new sample. Promise-rejection on autoplay
                // policy is harmless — the user can hit the inline play
                // button instead.
                setTimeout(() => {
                  const el = document.getElementById(
                    `tts-preview-${workerId}`,
                  ) as HTMLAudioElement | null;
                  el?.play().catch(() => {});
                }, 50);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            });
          }}
        >
          {pending ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              Synthesising…
            </>
          ) : (
            <>
              <Play className="mr-1 h-3.5 w-3.5" />
              Test voice
            </>
          )}
        </Button>
      </div>
      {audioUrl && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          <Volume2 className="h-4 w-4 text-muted-foreground" />
          <audio
            id={`tts-preview-${workerId}`}
            controls
            src={audioUrl}
            className="flex-1"
          />
        </div>
      )}
    </div>
  );
}
