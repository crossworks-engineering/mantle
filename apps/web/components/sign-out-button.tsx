'use client';

import { useState } from 'react';
import { performSignOut } from '@mantle/web-ui/sign-out';
import { useRouter } from 'next/navigation';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await performSignOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="text-xs text-muted-foreground hover:text-foreground"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
