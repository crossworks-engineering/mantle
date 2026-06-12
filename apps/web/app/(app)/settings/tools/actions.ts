'use server';

/**
 * Tools-settings server actions. The "require approval for agent-built tools"
 * preference governs whether Toolsmith-authored tools start confirm-gated
 * (see packages/tools/src/builtins-toolsmith.ts). Persistence lives in
 * @mantle/content so the agent runtime reads the same value.
 */

import { requireOwner } from '@/lib/auth';
import { updateProfilePreferences } from '@mantle/content';

export async function setToolsmithApprovalAction(value: boolean): Promise<void> {
  const user = await requireOwner();
  await updateProfilePreferences(user.id, { toolsmithRequireApproval: value === true });
}
