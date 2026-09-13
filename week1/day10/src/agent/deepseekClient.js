'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

const CHAT_PATH = '/chat/completions';

const AgentError = require('./errors').AgentError;

/**
 * The HTTP transport to DeepSeek's OpenAI-compatible chat-completions endpoint:
 * https://api-docs.deepseek.com/api/create-chat-completion
 *
 * It knows the wire format, the key, the timeout and how to turn failures into
 * AgentErrors — and nothing about memory or prompts. Both the agent (answers)
 * and the fact extractor (sticky facts) go through it.
 */
class DeepSeekClient {
  /**
   * @param {{apiKey?: string, apiUrl?: string, timeoutMs?: number}} options
   */
  constructor(options) {
    const opts = options || {};
    this.apiKey = opts.apiKey || '';
    this.endpoint = resolveEndpoint(opts.apiUrl || 'https://api.deepseek.com');
    this.timeoutMs = opts.timeoutMs || 60000;
  }

  get configured() {
    return this.apiKey.length > 0;
  }

  /**
   * One non-streaming completion.
   *
   * @param {{model: string, messages: object[], temperature?: number, maxTokens?: number,
   *          responseFormat?: 'text'|'json_object'}} request
   * @returns {Promise<{content: string, finishReason: string|null, model: string,
   *           usage: {input: number|null, output: number|null, total: number|null, reasoning: number|null}}>}
   */
  async chat(request) {
    if (!this.configured) {
      throw new AgentError('DEEPSEEK_API_KEY is not set on the server.', 503);
    }
    const body = { model: request.model, messages: request.messages, stream: false };
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens;
    if (request.responseFormat) body.response_format = { type: request.responseFormat };

    const parsed = await this._post(body);
    const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : undefined;
    if (typeof content !== 'string') {
      throw new AgentError('DeepSeek returned a malformed response (no message content).');
    }
    if (!content.trim()) {
      throw new AgentError('DeepSeek returned an empty answer. Please try again.');
    }
    return {
      content: content,
      finishReason: choice.finish_reason || null,
      model: typeof parsed.model === 'string' ? parsed.model : request.model,
      usage: parseUsage(parsed.usage)
    };
  }

  /** One HTTP round trip with a hard deadline. */
  _post(body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const target = url.parse(this.endpoint);
      const transport = target.protocol === 'http:' ? http : https;

      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };

      const req = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + this.apiKey,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            return fail(new AgentError('DeepSeek returned a response that is not JSON (HTTP ' + res.statusCode + ').'));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) return fail(httpError(res.statusCode, parsed));
          done(parsed);
        });
        res.on('error', (err) => fail(new AgentError('Lost the connection to DeepSeek. Please try again.', 502, err.message)));
      });

      // req.setTimeout() only covers socket inactivity; bound the whole exchange.
      const timer = setTimeout(() => {
        req.destroy();
        fail(new AgentError('DeepSeek did not answer within ' + Math.round(this.timeoutMs / 1000) + 's. Please try again.', 504));
      }, this.timeoutMs);

      req.on('close', () => clearTimeout(timer));
      req.on('error', (err) => fail(new AgentError('Could not reach DeepSeek. Check the server\'s network connection.', 502, err.message)));
      req.end(payload);
    });
  }
}

/** Accept either the base URL or the full endpoint. */
function resolveEndpoint(configured) {
  const trimmed = String(configured).trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(trimmed) ? trimmed : trimmed + CHAT_PATH;
}

/** Map an HTTP failure onto something a user can act on, leaking no internals. */
function httpError(status, parsed) {
  const detail = parsed && parsed.error && typeof parsed.error.message === 'string' ? parsed.error.message : null;
  if (status === 401) return new AgentError('DeepSeek rejected the API key. Check DEEPSEEK_API_KEY.', 502);
  if (status === 402) return new AgentError('The DeepSeek account is out of credit.', 502);
  if (status === 429) return new AgentError('DeepSeek is rate limiting this key. Please retry in a moment.', 429);
  if (status >= 500) return new AgentError('DeepSeek is unavailable right now (HTTP ' + status + '). Please try again.', 502);
  return new AgentError('DeepSeek rejected the request: ' + (detail || 'HTTP ' + status), 502);
}

/**
 * DeepSeek's own accounting — exact, because it comes from the tokenizer that
 * ran. `reasoning` is only present for reasoning models, whose completion count
 * includes thinking tokens that are not part of the stored answer.
 */
function parseUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const details = u.completion_tokens_details && typeof u.completion_tokens_details === 'object'
    ? u.completion_tokens_details : {};
  return {
    input: nonNegativeInt(u.prompt_tokens),
    output: nonNegativeInt(u.completion_tokens),
    total: nonNegativeInt(u.total_tokens),
    reasoning: nonNegativeInt(details.reasoning_tokens)
  };
}

function nonNegativeInt(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.round(value) : null;
}

module.exports = { DeepSeekClient, AgentError, resolveEndpoint, parseUsage };
