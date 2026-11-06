import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';

import { ErrorCodes } from '../dto/error-codes.js';

/** ["path: message", …] — Zod issues never contain the offending value. */
export function zodIssueList(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
}

/** "path: message; path: message". */
export function zodIssues(error: z.ZodError): string {
  return zodIssueList(error).join('; ');
}

/**
 * Validates a body, query or param against a Zod DTO schema (`modules/<m>/dto/*.dto.ts`) and
 * returns the parsed value; failures are 400 VALIDATION_FAILED. Empty bodies and queries are `{}`.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    const input =
      value === undefined && (metadata.type === 'body' || metadata.type === 'query') ? {} : value;
    const r = this.schema.safeParse(input);
    if (!r.success)
      throw new BadRequestException({
        message: zodIssues(r.error),
        code: ErrorCodes.VALIDATION_FAILED,
      });
    return r.data;
  }
}
