import { z } from 'zod';

/** One submitted value; its type and range are checked per setting (`settings.catalog.ts`). */
const SettingInput = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);

/** `PUT /api/settings`: set some settings and reset others (back to the environment or default). */
export const SaveSettingsSchema = z
  .object({
    values: z.record(z.string().min(1).max(64), SettingInput).default({}),
    reset: z.array(z.string().min(1).max(64)).max(64).default([]),
  })
  .strict()
  .refine((v) => Object.keys(v.values).length > 0 || v.reset.length > 0, {
    message: 'Nothing to change.',
  })
  .refine((v) => Object.keys(v.values).length <= 64, { message: 'Too many settings at once.' });
export type SaveSettingsDto = z.infer<typeof SaveSettingsSchema>;

/** `GET /api/settings/history?limit=`. */
export const SettingsHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type SettingsHistoryQueryDto = z.infer<typeof SettingsHistoryQuerySchema>;
