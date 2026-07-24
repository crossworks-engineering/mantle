import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { ChangePasswordForm } from './change-password-form';
import { DevicesPanel } from './devices-panel';

export default async function SecuritySettingsPage() {
  await requireOwner();

  return (
    <div className="mx-auto max-w-md space-y-6 px-6 py-8">
      <SetPageTitle title="Security" />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Change password
        </h2>
        <ChangePasswordForm />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Signed-in devices
        </h2>
        <DevicesPanel />
      </section>
    </div>
  );
}
