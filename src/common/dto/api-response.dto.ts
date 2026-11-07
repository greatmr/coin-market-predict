export interface ErrorMessage {
  message: string;
  code: string;
}

/** Every `/api/*` JSON response: exactly one of `data` / `errors` is non-null. */
export interface ApiResponse<T = unknown> {
  data: T | null;
  errors: ErrorMessage[] | null;
}

export function isApiResponse(value: unknown): value is ApiResponse {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'data' in value &&
    'errors' in value &&
    Object.keys(value).length === 2
  );
}
