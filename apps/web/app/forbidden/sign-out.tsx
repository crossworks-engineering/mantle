'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { supabaseBrowser } from '@/lib/supabase/client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.push('/login');
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
