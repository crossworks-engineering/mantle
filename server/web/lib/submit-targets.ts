/**
 * Where this box may send a submission (plan page 5559936a): its Admin
 * workspace, always. The Control Center's button joins on a box linked to
 * one (lib/control).
 */
import type { SubmitButton } from '@mantle/client-types/task-submissions';

export function submitTargets(): SubmitButton[] {
  return [{ to: 'admin', label: 'Admin' }];
}
