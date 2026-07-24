import { NextResponse } from 'next/server';
import { isFirstRun } from '@/lib/auth';

/**
 * GET /api/auth/bootstrap-state — is this a fresh install (no user yet)? Public
 * (pre-auth) so a detached login screen can choose sign-in vs. create-account
 * without DB access. Only a boolean leaks; the signup endpoint enforces the
 * single-user gate server-side regardless.
 */
export async function GET() {
  return NextResponse.json({ firstRun: await isFirstRun() });
}
