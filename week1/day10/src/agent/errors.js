'use strict';

/**
 * An error whose message is safe to show a user, carrying the HTTP status the
 * server should answer with. Anything else that escapes is treated as a bug and
 * reported to the browser generically.
 */
class AgentError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'AgentError';
    this.status = status || 502;
    this.detail = detail; // For the server log only.
  }
}

module.exports = { AgentError };
