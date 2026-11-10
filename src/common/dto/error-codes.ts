/** Stable error codes in the `{ data, errors: [{ message, code }] }` envelope. Add new ones here. */
export const ErrorCodes = {
  // ─── Request ─────────────────────────────────────────────────────────────
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  WRITE_FORBIDDEN: 'WRITE_FORBIDDEN',

  // ─── Sign-in and users ───────────────────────────────────────────────────
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_LOCKED: 'AUTH_LOCKED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  USER_INVALID: 'USER_INVALID',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  LAST_OWNER: 'LAST_OWNER',

  // ─── Tier 1 records, reviews and decisions ───────────────────────────────
  TIER1_RECORD_NOT_FOUND: 'TIER1_RECORD_NOT_FOUND',
  REVIEW_INVALID: 'REVIEW_INVALID',
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',

  // ─── Exports ─────────────────────────────────────────────────────────────
  EXPORT_FILE_NOT_FOUND: 'EXPORT_FILE_NOT_FOUND',

  // ─── Forward test ────────────────────────────────────────────────────────
  FORWARD_EVENT_NOT_FOUND: 'FORWARD_EVENT_NOT_FOUND',

  // ─── Telegram access ─────────────────────────────────────────────────────
  TELEGRAM_UNKNOWN_RECIPIENT: 'TELEGRAM_UNKNOWN_RECIPIENT',
  TELEGRAM_OWNER_TARGET: 'TELEGRAM_OWNER_TARGET',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
