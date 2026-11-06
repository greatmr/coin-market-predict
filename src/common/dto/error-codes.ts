/** Stable error codes in the `{ data, errors: [{ message, code }] }` envelope. Add new ones here. */
export const ErrorCodes = {
  // ─── Request ─────────────────────────────────────────────────────────────
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  WRITE_FORBIDDEN: 'WRITE_FORBIDDEN',

  // ─── Tier 1 records, reviews and decisions ───────────────────────────────
  TIER1_RECORD_NOT_FOUND: 'TIER1_RECORD_NOT_FOUND',
  REVIEW_INVALID: 'REVIEW_INVALID',
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',

  // ─── Exports ─────────────────────────────────────────────────────────────
  EXPORT_FILE_NOT_FOUND: 'EXPORT_FILE_NOT_FOUND',

  // ─── Telegram access ─────────────────────────────────────────────────────
  TELEGRAM_UNKNOWN_RECIPIENT: 'TELEGRAM_UNKNOWN_RECIPIENT',
  TELEGRAM_OWNER_TARGET: 'TELEGRAM_OWNER_TARGET',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
