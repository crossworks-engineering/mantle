'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@/components/layout/back-link';
import { SecretDetail, type SecretRow } from '../secret-detail';

/**
 * Deep-link wrapper for /secrets/[id], data-free. The master-detail list
 * (/secrets) is the primary surface now, but this route stays working as a
 * shareable deep link — it fetches the secret metadata from GET /api/secrets/[id]
 * and reuses the same SecretDetail, adding page chrome (title + back link).
 */
export function SecretDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [title, setTitle] = useState('');

  const secretQuery = useQuery({
    queryKey: ['secrets', id],
    queryFn: () => apiFetch<{ secret: SecretRow }>(`/api/secrets/${id}`),
    retry: false,
  });

  if (secretQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (secretQuery.isError) {
    const notFound = secretQuery.error instanceof ApiError && secretQuery.error.status === 404;
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
        <p>{notFound ? 'That secret no longer exists.' : "Couldn't load this secret."}</p>
        <Link href="/secrets" className="underline">
          ← All secrets
        </Link>
      </div>
    );
  }

  const secret = secretQuery.data.secret;
  return (
    <>
      <SetPageTitle title={title || secret.title} />
      <div className="px-6 pt-2">
        <BackLink href="/secrets">All secrets</BackLink>
      </div>
      <SecretDetail
        secret={secret}
        onUpdated={(s) => setTitle(s.title)}
        onDeleted={() => router.push('/secrets')}
      />
    </>
  );
}
