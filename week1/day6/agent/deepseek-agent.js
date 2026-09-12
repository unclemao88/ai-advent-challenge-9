'use strict';

const https = require('https');
const http = require('http');
const url = require('url');

const base = require('./agent');
const Agent = base.Agent;
const AgentError = base.AgentError;

const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Agent backed by DeepSeek's OpenAI-compatible chat-completions API.
 * https://api-docs.deepseek.com/api/create-chat-completion
 *
 * Holds everything DeepSeek-specific: endpoint, API key, model, the request
 * body, the HTTP call, response parsing, error mapping and the timeout.
 */
class DeepSeekAgent extends Agent {
  /**
   * @param {{apiKey: string, model?: string, apiUrl?: string,
   *          timeoutMs?: number, systemPrompt?: string}} options
   */
  constructor(options) {
    super();
    const opts = options || {};
    if (!opts.apiKey) {
      throw new Error('DeepSeekAgent requires an apiKey (set DEEPSEEK_API_KEY in the environment).');
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
    this.apiUrl = opts.apiUrl || DEFAULT_API_URL;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.systemPrompt = opts.systemPrompt || null;
  }

  describe() {
    return 'DeepSeek (' + this.model + ')';
  }

  /**
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  ask(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return Promise.reject(new AgentError('Please enter a question.', 400));
    }
    return this._post(this._buildRequest(prompt.trim())).then(parseAnswer);
  }

  /** Turn a question into a DeepSeek chat-completions request body. */
  _buildRequest(prompt) {
    const messages = [];
    if (this.systemPrompt) messages.push({ role: 'system', content: this.systemPrompt });
    messages.push({ role: 'user', content: prompt });
    return {
      model: this.model,
      messages: messages,
      stream: false
    };
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

      // setTimeout() only covers socket inactivity, so cover the whole exchange.
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

function humanDuration(ms) {
  return ms < 1000 ? ms + 'ms' : Math.round(ms / 1000) + 's';
}

/** Map an HTTP failure onto something a user can act on. */
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

module.exports = { DeepSeekAgent: DeepSeekAgent };
