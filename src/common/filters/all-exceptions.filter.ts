import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { ApiResponse, ErrorMessage } from '../dto/api-response.dto.js';
import { redact } from '../security/redact.js';

/**
 * Every HTTP error becomes `{ data: null, errors: [{ message, code }] }`. 5xx responses are logged
 * (redacted) and their message is generic: internal details never reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${redact(request.originalUrl ?? request.url)} → ${status}: ${redact(exception)}`,
        exception instanceof Error ? redact(exception.stack ?? '') : undefined,
      );
    }
    if (response.headersSent) return;
    const body: ApiResponse<null> = { data: null, errors: this.toErrorMessages(exception, status) };
    response.status(status).json(body);
  }

  private toErrorMessages(exception: unknown, status: number): ErrorMessage[] {
    const defaultCode = this.codeFromStatus(status);
    if (!(exception instanceof HttpException))
      return [{ message: 'Internal server error', code: defaultCode }];
    const raw = exception.getResponse();
    if (typeof raw === 'string') return [{ message: raw, code: defaultCode }];
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.errors))
        return obj.errors
          .map((e) => this.normalize(e, defaultCode))
          .filter((e): e is ErrorMessage => e !== null);
      const code = typeof obj.code === 'string' ? obj.code : defaultCode;
      if (Array.isArray(obj.message)) return obj.message.map((m) => ({ message: String(m), code }));
      if (typeof obj.message === 'string') return [{ message: obj.message, code }];
      if (typeof obj.error === 'string') return [{ message: obj.error, code }];
    }
    return [{ message: exception.message, code: defaultCode }];
  }

  private normalize(value: unknown, fallbackCode: string): ErrorMessage | null {
    if (typeof value === 'string') return { message: value, code: fallbackCode };
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v.message !== 'string') return null;
      return { message: v.message, code: typeof v.code === 'string' ? v.code : fallbackCode };
    }
    return null;
  }

  private codeFromStatus(status: number): string {
    const name = HttpStatus[status];
    return typeof name === 'string' ? name : `HTTP_${status}`;
  }
}
