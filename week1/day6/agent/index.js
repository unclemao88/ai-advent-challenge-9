'use strict';

const base = require('./agent');
const DeepSeekAgent = require('./deepseek-agent').DeepSeekAgent;
const EchoAgent = require('./echo-agent').EchoAgent;

/**
 * The single place where a concrete provider is chosen. Everything downstream
 * — the HTTP route, and through it the browser — sees only the Agent
 * interface, so swapping providers is a change to this function alone.
 *
 * @param {object} [env] Defaults to process.env.
 * @returns {import('./agent').Agent}
 */
function createAgent(env) {
  const e = env || process.env;
  const provider = (e.AGENT_PROVIDER || 'deepseek').toLowerCase();

  if (provider === 'echo') {
    return new EchoAgent();
  }

  if (provider === 'deepseek') {
    return new DeepSeekAgent({
      apiKey: e.DEEPSEEK_API_KEY,
      model: e.DEEPSEEK_MODEL,
      apiUrl: e.DEEPSEEK_API_URL,
      timeoutMs: positiveInt(e.AGENT_TIMEOUT_MS),
      systemPrompt: e.AGENT_SYSTEM_PROMPT
    });
  }

  throw new Error('Unknown AGENT_PROVIDER: ' + provider + ' (expected "deepseek" or "echo")');
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

module.exports = {
  createAgent: createAgent,
  Agent: base.Agent,
  AgentError: base.AgentError,
  DeepSeekAgent: DeepSeekAgent,
  EchoAgent: EchoAgent
};
