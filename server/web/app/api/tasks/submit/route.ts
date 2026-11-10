/**
 * The buttons of the submit form (plan page 5559936a): Send to Admin on
 * every box, and Send to IT (the Control Center's label) on a box linked to
 * one. Every login reads it: it names no item.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';
import { submitTargets } from '@/lib/submit-targets';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

export async function GET() {
  ownerCaller();
  return NextResponse.json({ buttons: submitTargets() });
}
