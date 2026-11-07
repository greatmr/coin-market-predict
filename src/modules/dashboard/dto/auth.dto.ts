import { z } from 'zod';

import { USER_ROLES } from '../../auth/permissions.js';

/** `POST /api/auth/login`. Lengths are bounded so an oversized body never reaches scrypt. */
export const LoginSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();
export type LoginDto = z.infer<typeof LoginSchema>;

/** `POST /api/auth/account`: change your own username and/or password (current password required). */
export const AccountSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    username: z.string().trim().min(1).max(64).optional(),
    newPassword: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((v) => v.username !== undefined || v.newPassword !== undefined, {
    message: 'Change the username, the password, or both.',
  });
export type AccountDto = z.infer<typeof AccountSchema>;

/** `POST /api/users`: a new user with a temporary password. */
export const CreateUserSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    role: z.enum(USER_ROLES),
    password: z.string().min(1).max(256),
  })
  .strict();
export type CreateUserDto = z.infer<typeof CreateUserSchema>;

/** `PATCH /api/users/:id`: role and/or active flag. */
export const UpdateUserSchema = z
  .object({ role: z.enum(USER_ROLES).optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((v) => v.role !== undefined || v.isActive !== undefined, {
    message: 'Nothing to change.',
  });
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;

/** `POST /api/users/:id/password`: a temporary password the user must change at next sign-in. */
export const ResetPasswordSchema = z.object({ password: z.string().min(1).max(256) }).strict();
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;
