'use client';

/**
 * Owner-side review actions for one pending forum upload (the Uploads section
 * of /team-admin?view=requests): Download (owner byte stream), Move to files
 * (→ files/review/<topic>/ + ingestion), Dismiss (drop the bytes; destructive
 * → AlertDialog). Mutations go through apiSend (owner bearer cross-origin);
 * the page's query refetches via `onDone`.
 */
import { useState, type ReactNode } from 'react';
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
import { apiSend, ApiError, apiUrl, withAuth } from '@mantle/web-ui/api-fetch';
import { runtimeApiBase } from '@mantle/web-ui/runtime-env';

/**
 * Owner download link for a byte-serving /api/team-admin route. Same-origin:
 * a plain new-tab anchor (cookie auth, inline preview). Split client origin:
 * a bare link can't carry the owner bearer, so fetch the bytes with it and
 * steer a synchronously-opened tab to the blob (popup blockers require the
 * open inside the click gesture).
 */
export function AdminDownloadLink({ path, children }: { path: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  if (runtimeApiBase() === '') {
    return (
      <Button variant="ghost" size="sm" className="text-muted-foreground" asChild>
        <a href={path} target="_blank" rel="noreferrer">
          {children}
        </a>
      </Button>
    );
  }
  const open = async () => {
    if (busy) return;
    setBusy(true);
    const tab = window.open('', '_blank');
    try {
      const r = await fetch(apiUrl(path), withAuth());
      if (!r.ok) {
        tab?.close();
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      if (tab) tab.location = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      tab?.close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      disabled={busy}
      onClick={() => void open()}
    >
      {children}
    </Button>
  );
}

export function UploadReviewActions({
  uploadId,
  filename,
  onDone,
}: {
  uploadId: string;
  filename: string;
  /** Refetch hook for the client-query page (router.refresh() only re-runs
   *  server components, which no longer carry this data). */
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<'file' | 'dismiss' | null>(null);

  const act = async (action: 'file' | 'dismiss') => {
    setBusy(action);
    try {
      await apiSend(`/api/team-admin/forum/uploads/${uploadId}/${action}`, 'POST');
      if (action === 'file') {
        toast.success(`Filed ${filename} into files/review — ingestion is running`);
      } else {
        toast.success(`Dismissed ${filename}`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reach the server — try again');
    } finally {
      router.refresh();
      onDone?.();
      setBusy(null);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <AdminDownloadLink path={`/api/team-admin/forum/uploads/${uploadId}/download`}>
        <Download /> Download
      </AdminDownloadLink>
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
