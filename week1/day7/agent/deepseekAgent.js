'use strict';

const https = require('https');
const http = require('http');
const url = require('url');

const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60000;

const SYSTEM_PROMPT =
  'You are a helpful AI agent. Use the previous conversation history as context ' +
  'when answering new questions. Maintain continuity with the user\'s previous ' +
  'requests and your previous answers.';

/**
 * An error whose message is safe to show a user, carrying the HTTP status the
 * server should answer with. Anything else that escapes the agent is a bug and
 * gets a generic message instead.
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
 *   const answer = await agent.ask(question, history);
 *
 * Everything DeepSeek-specific is in this file — endpoint, credentials, model,
 * wire format, error mapping, timeout. Nothing outside it mentions DeepSeek.
 * DeepSeek's API is OpenAI-compatible, so this is a plain chat-completions call.
 * https://api-docs.deepseek.com/api/create-chat-completion
 */
class DeepSeekAgent {
  /**
   * @param {{apiKey: string, model?: string, apiUrl?: string,
   *          timeoutMs?: number, historyLimit?: number}} options
   */
  constructor(options) {
    const opts = options || {};
    if (!opts.apiKey) {
      throw new Error('Missing DEEPSEEK_API_KEY. Copy .env.example to .env and set the key.');
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
    this.apiUrl = opts.apiUrl || DEFAULT_API_URL;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    // 0 means "replay the whole conversation", which is the default.
    this.historyLimit = opts.historyLimit || 0;
  }

  /** Short label for the startup log and the page footer. Never includes the key. */
  describe() {
    return 'DeepSeek (' + this.model + ')';
  }

  /**
   * @param {string} question The user's question, already trimmed.
   * @param {Array<{role: string, content: string}>} [history] Stored messages, oldest first.
   * @returns {Promise<string>} The answer text.
   */
  ask(question, history) {
    if (typeof question !== 'string' || !question.trim()) {
      return Promise.reject(new AgentError('Please enter a question.', 400));
    }
    return this._post(this._buildRequest(question.trim(), history || [])).then(parseAnswer);
  }

  /**
   * The stored history *is* the agent's memory: it is replayed as chat messages
   * ahead of the new question, which is what lets the agent answer "what is my
   * name?" after a server restart.
   */
  _buildRequest(question, history) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    this.selectHistory(history).forEach(function (message) {
      messages.push({ role: message.role, content: message.content });
    });
    messages.push({ role: 'user', content: question });

    return { model: this.model, messages: messages, stream: false };
  }

  /**
   * The single place that decides how much of the past is sent. It keeps
   * everything by default; a token budget or a summarising step belongs here
   * and nowhere else.
   */
  selectHistory(history) {
    const usable = history.filter(function (message) {
      return message
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
        && message.content.trim();
    });
    return this.historyLimit > 0 ? usable.slice(-this.historyLimit) : usable;
  }

  /** One HTTPS round trip, with a hard timeout and errors mapped to AgentError. */
  _post(body) {
    const self = this;
    return new Promise(function (resolve, reject) {
      const payload = JSON.stringify(body);
      const target = url.parse(self.apiUrl);
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
          } catch (e) {
            // A proxy or captive portal in front of the API, or a 5xx HTML page.
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
      timer.unref && timer.unref();

      req.on('close', function () { clearTimeout(timer); });
      req.on('error', function (err) {
        fail(new AgentError('Could not reach DeepSeek: ' + err.message));
      });
      req.end(payload);
    });
  }
}

/**
 * The one place the agent is configured, so the model name is read from the
 * environment exactly once.
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
    historyLimit: positiveInt(e.DEEPSEEK_HISTORY_LIMIT)
  });
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
    return new AgentError('DeepSeek rejected the API key. Check DEEPSEEK_API_KEY.', 502);
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

module.exports = {
  DeepSeekAgent: DeepSeekAgent,
  AgentError: AgentError,
  createAgent: createAgent,
  SYSTEM_PROMPT: SYSTEM_PROMPT
};
