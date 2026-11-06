import { NextResponse } from '@/server/http-compat';
import { routePolicy } from '@/lib/auth/route-declaration';
import { updateNoticeView } from '@/lib/update-notice';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings', public: true },
});

/**
 * GET /api/update-notice: whether this box shows every login the "Update In
 * Progress" notice, and the build it runs. Deliberately unauthenticated (in
 * PUBLIC_PATHS): every signed-in tab polls it, and the sign-in page shows the
 * notice too, so a login sent there mid-restart still sees why. It tells
 * anyone one boolean beside the version /api/version already tells. Never
 * stored by a browser or a proxy (the /api default), cached 5 s in the
 * process. Switched by update_notice_on / update_notice_off.
 */
export async function GET() {
  return NextResponse.json(await updateNoticeView());
}
