'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

const tokenCounter = require('../utils/tokenCounter');
const contextBudget = require('../utils/contextBudget');

const DEFAULT_API_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60000;
// How many tokens of conversation may be replayed as context. The model itself
// allows far more; this is a cost and latency control, since every question
// resends the whole prompt. 0 disables the budget.
const DEFAULT_MAX_CONTEXT_TOKENS = 20000;
const CHAT_PATH = '/chat/completions';

const SYSTEM_PROMPT =
  'You are a helpful AI agent. Use the previous conversation history as context ' +
  'when answering new questions. Maintain continuity with the user\'s earlier ' +
  'requests and your earlier answers.';

/**
 * An error whose message is safe to show a user, carrying the HTTP status the
 * server should answer with. Anything else escaping this module is a bug and
 * gets a generic message instead, so internals never reach the browser.
 */
class AgentError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AgentError';
    this.status = status || 502;
  }
}

/**
 * The agent: turns a question plus the stored conversation into an answer.
 *
 *   const result = await agent.ask(question, history);
 *   // → { answer, usage: { promptTokens, completionTokens, totalTokens }, model }
 *
 * Everything DeepSeek-specific lives in this file — endpoint, credentials,
 * model, wire format, error mapping, timeout. Nothing outside it mentions
 * DeepSeek, and the browser never talks to it directly. DeepSeek's API is
 * OpenAI-compatible, so this is a plain chat-completions call:
 * https://api-docs.deepseek.com/api/create-chat-completion
 */
class DeepSeekAgent {
  /**
   * @param {{apiKey: string, model?: string, apiUrl?: string,
   *          timeoutMs?: number, historyLimit?: number,
   *          maxContextTokens?: number, systemPrompt?: string}} options
   */
  constructor(options) {
    const opts = options || {};
    if (!opts.apiKey || !String(opts.apiKey).trim()) {
      throw new Error('Missing DEEPSEEK_API_KEY. Copy .env.example to .env and set the key.');
    }
    this.apiKey = String(opts.apiKey).trim();
    this.model = opts.model || DEFAULT_MODEL;
    this.endpoint = resolveEndpoint(opts.apiUrl || DEFAULT_API_URL);
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.systemPrompt = opts.systemPrompt || SYSTEM_PROMPT;
    // 0 means "no cap on the number of messages replayed"; the token budget
    // below is the limit that normally binds.
    this.historyLimit = opts.historyLimit || 0;
    this.maxContextTokens = opts.maxContextTokens === 0
      ? 0
      : (opts.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS);
  }

  /** Short label for the startup log. Never includes the key. */
  describe() {
    return 'DeepSeek (' + this.model + ') at ' + this.endpoint
      + ', context budget ' + (this.maxContextTokens ? this.maxContextTokens + ' tokens' : 'unlimited');
  }

  /**
   * Ask a question with the stored conversation as context.
   *
   * @param {string} question The user's question.
   * @param {Array<{role: string, content: string}>} [history] Stored messages, oldest first.
   * @returns {Promise<{answer: string, usage: object, model: string, contextMessageCount: number}>}
   */
  ask(question, history) {
    if (typeof question !== 'string' || !question.trim()) {
      return Promise.reject(new AgentError('Please enter a question.', 400));
    }

    const plan = this.planContext(history || [], question.trim());
    const self = this;

    return this._post({ model: this.model, messages: plan.messages, stream: false })
      .then(function (parsed) {
        return {
          answer: parseAnswer(parsed),
          usage: parseUsage(parsed),
          model: (parsed && parsed.model) || self.model,
          // Excludes the system prompt and the new question: how much memory was replayed.
          contextMessageCount: plan.includedMessages,
          context: plan.stats
        };
      });
  }

  /**
   * Turn stored history plus the new question into DeepSeek chat messages.
   *
   * The stored history *is* the agent's memory: it is replayed ahead of the new
   * question, which is what lets the agent answer "what is my name?" after a
   * browser refresh or a server restart.
   *
   * This is the single place that decides how much of the past is sent, so a
   * token budget, a trimming rule or a summarising step belongs here and
   * nowhere else. `estimateContextTokens` below reports what this would cost.
   *
   * @param {Array<{role: string, content: string}>} history Oldest first.
   * @param {string} currentQuestion
   * @returns {Array<{role: string, content: string}>}
   */
  buildConversationContext(history, currentQuestion) {
    return this.planContext(history, currentQuestion).messages;
  }

  /**
   * Decide what to send, and report what that cost.
   *
   * The stored history is the agent's memory, but not all of it necessarily
   * travels: messages are taken newest-first until the token budget is spent,
   * so a long conversation keeps its recent context and drops its distant past.
   * Nothing is deleted — history.json still holds every message; this only
   * governs what goes over the wire.
   *
   * @param {Array<{role: string, content: string, tokenCount?: number}>} history Oldest first.
   * @param {string} currentQuestion
   * @returns {{messages: Array, includedMessages: number, stats: object}}
   */
  planContext(history, currentQuestion) {
    const question = String(currentQuestion == null ? '' : currentQuestion);
    const usable = this.selectHistory(history);

    // The shared rule decides what fits; this method only supplies the costs.
    const plan = contextBudget.plan(usable.map(storedContentTokens), {
      budget: this.maxContextTokens,
      systemTokens: tokenCounter.estimateTokens(this.systemPrompt),
      questionTokens: tokenCounter.estimateTokens(question),
      overhead: tokenCounter.MESSAGE_OVERHEAD_TOKENS
    });

    const kept = plan.includedMessages ? usable.slice(-plan.includedMessages) : [];
    const messages = [{ role: 'system', content: this.systemPrompt }];
    kept.forEach(function (message) {
      messages.push({ role: message.role, content: message.content });
    });
    messages.push({ role: 'user', content: question });

    return {
      messages: messages,
      includedMessages: kept.length,
      stats: {
        budget: plan.budget,
        // Estimated, because only the answers carry an exact stored count.
        estimatedTokens: plan.estimatedTokens,
        historyTokens: plan.historyTokens,
        includedMessages: plan.includedMessages,
        trimmedMessages: plan.trimmedMessages,
        storedMessages: usable.length,
        // What the page needs to reproduce this walk as the user types.
        systemTokens: tokenCounter.estimateTokens(this.systemPrompt),
        overhead: tokenCounter.MESSAGE_OVERHEAD_TOKENS
      }
    };
  }

  /**
   * Which stored messages are eligible at all: well-formed, and within
   * DEEPSEEK_HISTORY_LIMIT if one is set. The token budget is applied after
   * this, in planContext().
   */
  selectHistory(history) {
    const usable = (Array.isArray(history) ? history : []).filter(function (message) {
      return Boolean(message)
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
        && message.content.trim().length > 0;
    });
    return this.historyLimit > 0 ? usable.slice(-this.historyLimit) : usable;
  }

  /**
   * What the next request would cost, as an estimate — after trimming, so this
   * never exceeds the budget.
   */
  estimateContextTokens(history, currentQuestion) {
    return this.planContext(history, currentQuestion || '').stats.estimatedTokens;
  }

  /** One HTTP round trip, with a hard timeout and errors mapped to AgentError. */
  _post(body) {
    const self = this;
    return new Promise(function (resolve, reject) {
      const payload = JSON.stringify(body);
      const target = url.parse(self.endpoint);
      const transport = target.protocol === 'http:' ? http : https;

      let settled = false;
      function fail(err) {
        if (settled) return;
        settled = true;
        reject(err);
      }
      function done(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      const req = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + self.apiKey,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, function (res) {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            // A proxy, a captive portal, or a 5xx HTML error page.
            return fail(new AgentError(
              'DeepSeek returned a response that is not JSON (HTTP ' + res.statusCode + ').'));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return fail(httpError(res.statusCode, parsed));
          }
          done(parsed);
        });
        res.on('error', function (err) {
          fail(new AgentError('Lost the connection to DeepSeek: ' + err.message));
        });
      });

      // req.setTimeout() only covers socket inactivity, so cover the whole exchange.
      const timer = setTimeout(function () {
        req.destroy();
        fail(new AgentError(
          'DeepSeek did not answer within ' + humanDuration(self.timeoutMs) + '. Please try again.', 504));
      }, self.timeoutMs);
      if (timer.unref) timer.unref();

      req.on('close', function () { clearTimeout(timer); });
      req.on('error', function (err) {
        fail(new AgentError('Could not reach DeepSeek: ' + err.message));
      });
      req.end(payload);
    });
  }
}

/**
 * The one place the agent is configured, so the environment is read exactly
 * once. Throws when the key is missing — the server reports that as a clear
 * startup failure instead of failing on the first question.
 *
 * @param {object} [env] Defaults to process.env.
 */
function createAgent(env) {
  const e = env || process.env;
  return new DeepSeekAgent({
    apiKey: e.DEEPSEEK_API_KEY,
    model: e.DEEPSEEK_MODEL,
    apiUrl: e.DEEPSEEK_API_URL,
    timeoutMs: positiveInt(e.DEEPSEEK_TIMEOUT_MS),
    historyLimit: positiveInt(e.DEEPSEEK_HISTORY_LIMIT),
    maxContextTokens: nonNegativeIntSetting(e.DEEPSEEK_MAX_CONTEXT_TOKENS)
  });
}

/**
 * Accept either a base URL (`https://api.deepseek.com`, as in .env.example) or
 * a full endpoint, so both spellings work.
 */
function resolveEndpoint(configured) {
  const trimmed = String(configured).trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_API_URL + CHAT_PATH;
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return trimmed + CHAT_PATH;
}

/**
 * A budget setting: a positive number, or an explicit 0 meaning "no budget".
 * Anything else (unset, blank, nonsense) leaves the default in place.
 */
function nonNegativeIntSetting(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Content tokens of a stored message. Prefers the count already on the record —
 * exact for answers, since it came from DeepSeek — and estimates only when
 * absent. Framing overhead is added by the budget rule, not here.
 */
function storedContentTokens(message) {
  const stored = Number(message.tokenCount);
  return Number.isFinite(stored) && stored >= 0
    ? Math.round(stored)
    : tokenCounter.estimateTokens(message.content);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function humanDuration(ms) {
  return ms < 1000 ? ms + 'ms' : Math.round(ms / 1000) + 's';
}

/** Map an HTTP failure onto something a user can act on, leaking no internals. */
function httpError(status, parsed) {
  const detail = parsed && parsed.error && parsed.error.message ? parsed.error.message : null;
  if (status === 401) {
    return new AgentError('DeepSeek rejected the API key. Check DEEPSEEK_API_KEY in .env.', 502);
  }
  if (status === 402) {
    return new AgentError('The DeepSeek account is out of credit.', 502);
  }
  if (status === 429) {
    return new AgentError('DeepSeek is rate limiting this key. Please retry in a moment.', 429);
  }
  if (status >= 500) {
    return new AgentError('DeepSeek is unavailable right now (HTTP ' + status + '). Please try again.', 502);
  }
  return new AgentError('DeepSeek rejected the request: ' + (detail || 'HTTP ' + status), 502);
}

/** Pull the answer text out of a chat-completions response. */
function parseAnswer(parsed) {
  const choice = parsed && parsed.choices && parsed.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string') {
    throw new AgentError('DeepSeek returned a response with no message content.');
  }
  if (!content.trim()) {
    throw new AgentError('DeepSeek returned an empty answer. Please try rephrasing the question.');
  }
  return content;
}

/**
 * DeepSeek's own token accounting. These numbers are exact — they come from the
 * tokenizer that actually ran — so the server prefers them over its estimate.
 * Any field can be absent, hence the null checks.
 */
function parseUsage(parsed) {
  const usage = parsed && parsed.usage;
  return {
    promptTokens: nonNegativeInt(usage && usage.prompt_tokens),
    completionTokens: nonNegativeInt(usage && usage.completion_tokens),
    totalTokens: nonNegativeInt(usage && usage.total_tokens)
  };
}

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

module.exports = {
  DeepSeekAgent: DeepSeekAgent,
  AgentError: AgentError,
  createAgent: createAgent,
  resolveEndpoint: resolveEndpoint,
  DEFAULT_MAX_CONTEXT_TOKENS: DEFAULT_MAX_CONTEXT_TOKENS,
  SYSTEM_PROMPT: SYSTEM_PROMPT
};
