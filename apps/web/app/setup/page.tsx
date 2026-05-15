import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { getSessionUser } from '@/lib/auth';
import { SetupForm } from './setup-form';

/**
 * First-run page. After Supabase Auth confirms the signup, the user is told
 * to copy their `user.id` into the `ALLOWED_USER_ID` env var — that's what
 * locks Mantle to a single owner until proper RBAC lands.
 */
export default async function SetupPage() {
  const user = await getSessionUser();
  const allow = process.env.ALLOWED_USER_ID;
  if (allow && user && user.id === allow) {
    redirect('/');
  }

  if (user) {
    return (
      <main className="mx-auto max-w-md space-y-6 px-4 py-16">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Welcome to Mantle.</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="font-medium">{user.email}</span>.
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted p-4 text-sm">
          <p className="mb-2 font-medium">One last step.</p>
          <p className="mb-3 text-muted-foreground">
            Copy this user id into <code className="font-mono">ALLOWED_USER_ID</code> in
            <code className="font-mono"> .env.local</code>, then restart <code>pnpm dev</code>:
          </p>
          <pre className="overflow-x-auto rounded bg-background p-3 font-mono text-xs">{user.id}</pre>
        </div>
        <Button asChild className="w-full">
          <Link href="/">Open my dashboard</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">Plant your Mantle</h1>
          <p className="text-sm text-muted-foreground">Create your owner account.</p>
        </div>
        <SetupForm />
      </div>
    </main>
  );
}
