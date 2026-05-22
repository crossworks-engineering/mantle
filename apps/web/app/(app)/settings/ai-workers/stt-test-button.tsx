'use client';

/**
 * Browser-side STT preview. Records a short clip with the
 * MediaRecorder API, sends it as base64 to the test action, shows
 * the transcript + detected language + duration.
 *
 * Helpful for confirming the language hint is doing what you expect
 * before voice messages in Telegram start coming back wrong.
 */

import { useRef, useState, useTransition } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { testSttAction } from './actions';

export function SttTestButton({ workerId }: { workerId: string }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState<{
    text: string;
    language: string | null;
    duration: number | null;
  } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        // Stop all tracks so the browser tab indicator clears.
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        blob.arrayBuffer().then((buf) => {
          const base64 = bufferToBase64(buf);
          startTransition(async () => {
            try {
              const r = await testSttAction(workerId, base64, mr.mimeType);
              setResult({ text: r.text, language: r.language, duration: r.duration });
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            }
          });
        });
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setRecording(true);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Couldn't access microphone: ${err.message}`
          : 'Microphone access denied',
      );
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  return (
    <div className="space-y-3">
      <div>
        {!recording ? (
          <Button
            type="button"
            variant="outline"
            onClick={startRecording}
            disabled={pending}
          >
            {pending ? (
              <>
                <Loader2 className="animate-spin" />
                Transcribing…
              </>
            ) : (
              <>
                <Mic />
                Start recording
              </>
            )}
          </Button>
        ) : (
          <Button type="button" variant="destructive" onClick={stopRecording}>
            <MicOff />
            Stop and transcribe
          </Button>
        )}
      </div>
      {result && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <p className="font-medium">{result.text || '(empty transcript)'}</p>
          <p className="text-xs text-muted-foreground">
            {result.language && `language: ${result.language}`}
            {result.duration != null &&
              ` · ${result.duration.toFixed(1)}s of audio`}
          </p>
        </div>
      )}
    </div>
  );
}

/** Browser-safe base64 encoder for an ArrayBuffer. `btoa` doesn't
 *  take typed arrays directly. Chunk through `String.fromCharCode` to
 *  avoid call-stack limits on big buffers. */
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
