/**
 * Errors whose message is safe to show the user.
 *
 * Anything that reaches the HTTP error handler and is not an AppError (or a
 * provider error with the same shape) is treated as a bug: logged in full,
 * reported to the browser as one generic sentence.
 */
export class AppError extends Error {
  /**
   * @param {number} status HTTP status to answer with.
   * @param {string} message Safe to show to the user.
   * @param {string} code Stable machine-readable code.
   * @param {{details?: object, cause?: unknown}} [options] `details` is sent to the browser too.
   */
  constructor(status, message, code, { details, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const badRequest = (message, code = 'invalid_input') => new AppError(400, message, code);
export const notFound = (message, code = 'not_found') => new AppError(404, message, code);
export const conflict = (message, code = 'conflict') => new AppError(409, message, code);

/** A persistence failure: the message names what failed, never where on disk. */
export class StorageError extends AppError {
  constructor(what, cause) {
    super(500, `Could not ${what}. The data on disk was not changed. Check the server log.`, 'storage_error', { cause });
    this.name = 'StorageError';
  }
}
