/**
 * An error whose message is safe to show the user, with the HTTP status the
 * API should answer with. Anything else reaching the error handler is treated
 * as a bug and reported with a generic message, so internals never leak.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [code] Stable machine-readable code for the UI and tests.
   */
  constructor(status, message, code = 'bad_request') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
