import { SignOutButton } from './sign-out';

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Not your Mantle.</h1>
        <p className="text-sm text-muted-foreground">
          This installation is locked to a single owner. Sign out and use the right account, or set{' '}
          <code className="font-mono">ALLOWED_USER_ID</code> in <code className="font-mono">.env.local</code>{' '}
          to your <code className="font-mono">auth.users.id</code>.
        </p>
        <SignOutButton />
      </div>
    </main>
  );
}
