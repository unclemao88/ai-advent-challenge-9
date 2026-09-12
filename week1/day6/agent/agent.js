'use strict';

/**
 * The Agent interface — the only thing the rest of the application is allowed
 * to depend on.
 *
 *   const answer = await agent.ask(question);
 *
 * Everything provider-specific (endpoint, credentials, model, wire format,
 * timeouts) lives behind this method. Swapping DeepSeek for another provider
 * means adding a class here and changing one line in agent/index.js; no server
 * route and no UI code changes.
 *
 * JavaScript has no `interface`, so this base class documents the contract and
 * fails loudly if a subclass forgets to honour it.
 */
class Agent {
  /**
   * @param {string} prompt The user's question, already trimmed.
   * @returns {Promise<string>} The answer text.
   * @throws {AgentError} When the question cannot be answered.
   */
  ask(prompt) { // eslint-disable-line no-unused-vars
    return Promise.reject(new Error(this.constructor.name + ' does not implement ask(prompt)'));
  }

  /** Short label for logs and the UI footer. Providers should override. */
  describe() {
    return this.constructor.name;
  }
}

/**
 * An error whose message is safe to show a user, carrying the HTTP status the
 * server should answer with. Anything else that escapes an agent is a bug and
 * gets a generic message instead.
 */
class AgentError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AgentError';
    this.status = status || 502;
  }
}

module.exports = { Agent: Agent, AgentError: AgentError };
