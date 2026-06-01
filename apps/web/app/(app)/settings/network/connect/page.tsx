import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { ConnectGuide } from './connect-guide';

/**
 * "Connect a device" — a self-contained, platform-by-platform guide for joining
 * a machine (a home GPU / LAN box running Ollama or LM Studio) to your tailnet,
 * then pointing a Mantle route at it. Ships with Mantle: written for any
 * self-hoster, not just this install. Static content — no server data needed.
 */
export default async function ConnectPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Connect a device" />
      <ConnectGuide />
    </>
  );
}
