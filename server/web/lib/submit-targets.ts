/**
 * Where this box may send a submission (plan page 5559936a): its Admin
 * workspace, always, and the Control Center on a box linked to one (the
 * CC's name from MANTLE_CONTROL_CENTER_LABEL, IT by default).
 */
import type { SubmitButton } from '@mantle/client-types/task-submissions';
import { controlCenterLabel, subjectConfig } from '@/lib/control/env';

export function submitTargets(): SubmitButton[] {
  const buttons: SubmitButton[] = [];
  if (subjectConfig().on) buttons.push({ to: 'it', label: controlCenterLabel() });
  buttons.push({ to: 'admin', label: 'Admin' });
  return buttons;
}
