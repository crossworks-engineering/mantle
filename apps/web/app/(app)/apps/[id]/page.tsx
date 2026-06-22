import { notFound } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import { getApp } from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { AppDetailClient } from './app-detail-client';

export default async function AppDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const app = await getApp(user.id, id);
  if (!app) notFound();

  return (
    <>
      <SetPageTitle title={app.title} />
      <AppDetailClient app={app} />
    </>
  );
}
