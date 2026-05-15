import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase/server';

/** Returns the current Supabase user or `null`. Safe to call in Server Components. */
export async function getSessionUser() {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  return data.user;
}

/**
 * Gate for protected pages. Redirects to `/login` if no session, or to
 * `/forbidden` if the session belongs to someone other than ALLOWED_USER_ID.
 */
export async function requireOwner() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const allow = process.env.ALLOWED_USER_ID;
  if (allow && user.id !== allow) {
    redirect('/forbidden');
  }
  return user;
}
