/**
 * The fields that name and dress an app, one definition for every route that
 * takes them (POST /api/apps, POST /api/apps/import), so the import route
 * never accepts looser fields than the create.
 */
import { z } from 'zod';
import { APP_ICON_MAX, APP_TINTS } from '@mantle/client-types/app-nav';

export const APP_DESCRIPTION_MAX = 2000;

export const AppMetaFields = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(APP_DESCRIPTION_MAX).optional(),
  icon: z.string().max(APP_ICON_MAX).optional(),
  color: z.enum(APP_TINTS).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});
