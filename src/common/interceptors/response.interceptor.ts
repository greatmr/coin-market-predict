import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, map } from 'rxjs';

import { type ApiResponse, isApiResponse } from '../dto/api-response.dto.js';

/** Wraps every controller result in `{ data, errors: null }` (handlers using `@Res()` are untouched). */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    return next
      .handle()
      .pipe(
        map((data) =>
          isApiResponse(data)
            ? (data as ApiResponse<T>)
            : { data: (data ?? null) as T | null, errors: null },
        ),
      );
  }
}
