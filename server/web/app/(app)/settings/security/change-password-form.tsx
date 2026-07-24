'use client';

import { useState } from 'react';
import { apiUrl, withAuth } from '@mantle/web-ui/api-fetch';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';

export function ChangePasswordForm() {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (newPassword === oldPassword) {
      setError('New password must be different from the current one.');
      return;
    }

    setBusy(true);
    const res = await fetch(
      apiUrl('/api/auth/change-password'),
      withAuth({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      }),
    );
    setBusy(false);

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Password change failed.');
      return;
    }

    setSuccess('Password updated. Use the new one next time you sign in.');
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="old-password">Current password</Label>
        <Input
          id="old-password"
          type="password"
          autoComplete="current-password"
          required
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          At least 8 characters. A passphrase or password-manager-generated string is fine.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
          {success}
        </p>
      )}

      <SubmitButton pending={busy} className="w-full">
        Update password
      </SubmitButton>
    </form>
  );
}
