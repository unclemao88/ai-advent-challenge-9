'use strict';

const base = require('./agent');
const Agent = base.Agent;
const AgentError = base.AgentError;

/**
 * A second implementation of the same interface, used to run the UI without a
 * DeepSeek key (AGENT_PROVIDER=echo). It exists mainly as proof that the app
 * really does depend on Agent and not on DeepSeek: nothing outside
 * agent/index.js changes when this one is selected.
 */
class EchoAgent extends Agent {
  constructor(options) {
    super();
    this.delayMs = (options && options.delayMs) || 400;
  }

  describe() {
    return 'Echo (no provider)';
  }

  ask(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return Promise.reject(new AgentError('Please enter a question.', 400));
    }
    const self = this;
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve('Echo agent (no LLM configured). You asked:\n\n' + prompt.trim());
      }, self.delayMs);
    });
  }
}

module.exports = { EchoAgent: EchoAgent };
