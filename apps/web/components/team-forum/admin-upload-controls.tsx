'use client';

/**
 * Owner-side review actions for one pending forum upload (the Uploads section
 * of /team-admin?view=requests): Download (owner byte stream), Move to files
 * (→ files/review/<topic>/ + ingestion), Dismiss (drop the bytes; destructive
 * → AlertDialog). Server-rendered page + router.refresh() after each
 * mutation, matching the team-admin conventions.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, FolderInput, Loader2, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@mantle/web-ui/ui/alert-dialog';
import { Button } from '@mantle/web-ui/ui/button';
import { useToast } from '@mantle/web-ui/ui/toast';

export function UploadReviewActions({
  uploadId,
  filename,
}: {
  uploadId: string;
  filename: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<'file' | 'dismiss' | null>(null);

  const act = async (action: 'file' | 'dismiss') => {
    setBusy(action);
    try {
      const r = await fetch(`/api/team-admin/forum/uploads/${uploadId}/${action}`, {
        method: 'POST',
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; parentPath?: string };
      if (!r.ok) {
        toast.error(data.error ?? 'The action failed — try again');
      } else if (action === 'file') {
        toast.success(`Filed ${filename} into files/review — ingestion is running`);
      } else {
        toast.success(`Dismissed ${filename}`);
      }
      router.refresh();
    } catch {
      toast.error('Could not reach the server — try again');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button variant="ghost" size="sm" className="text-muted-foreground" asChild>
        <a
          href={`/api/team-admin/forum/uploads/${uploadId}/download`}
          target="_blank"
          rel="noreferrer"
        >
          <Download /> Download
        </a>
      </Button>
      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act('file')}>
        {busy === 'file' ? <Loader2 className="animate-spin" /> : <FolderInput />}
        Move to files
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className="text-destructive" disabled={busy !== null}>
            {busy === 'dismiss' ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Dismiss
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss this upload?</AlertDialogTitle>
            <AlertDialogDescription>
              The uploaded bytes of “{filename}” are deleted and it never enters the brain. The
              member&rsquo;s post keeps a “removed” chip. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void act('dismiss')}
            >
              Dismiss upload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
