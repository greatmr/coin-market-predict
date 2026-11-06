import { QueryFailedError } from 'typeorm';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/** A write lost to a unique constraint or index. The constraint is the authority, not a prior read. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === POSTGRES_UNIQUE_VIOLATION
  );
}
