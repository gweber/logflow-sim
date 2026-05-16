/**
 * Structured error hierarchy used by the kernel.
 *
 * Every kernel function throws a subclass of `DomainError` for problems the
 * caller is expected to handle (bad input, unknown dialect, missing
 * resource). Plain JavaScript `Error` is reserved for genuinely unexpected
 * conditions ("invariant violated"); those become HTTP 500.
 *
 * The class name is mapped to an HTTP status by the API adapter (see
 * `src/api/error-handler.ts`), so the same error means the same thing
 * whether it's raised through HTTP, CLI, or the browser worker.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  /** Free-form structured data attached to the error for logging / UI. */
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    httpStatus: number,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.context = context;
  }
}

/** Caller passed something the kernel can't make sense of (bad query, malformed JSON). */
export class BadRequestError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'BAD_REQUEST', 400, context);
  }
}

/** The requested resource isn't there — unknown dialect ID, missing file. */
export class NotFoundError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'NOT_FOUND', 404, context);
  }
}

/** A dialect plugin doesn't implement the capability the caller asked for. */
export class UnsupportedOperationError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'UNSUPPORTED', 422, context);
  }
}

/** Path traversal attempt or other escape from the VFS root. */
export class ForbiddenError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'FORBIDDEN', 403, context);
  }
}

/** Generic "operation failed for an expected reason" — the catch-all 4xx. */
export class OperationError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'OPERATION_FAILED', 400, context);
  }
}

/** Type guard: is this throwable a DomainError we know how to map? */
export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
