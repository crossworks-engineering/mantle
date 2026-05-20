import { redirect } from 'next/navigation';
import { LoginForm } from './login-form';
import { getSessionUser } from '@/lib/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  if (user) redirect(params.next ?? '/');

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="font-logo text-5xl leading-none text-primary">mantle</h1>
          <p className="text-sm text-muted-foreground">Sign in to your tree.</p>
        </div>
        <LoginForm next={params.next} error={params.error} />
      </div>
    </main>
  );
}
