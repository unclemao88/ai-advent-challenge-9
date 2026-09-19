/**
 * The only module that talks to DeepSeek.
 *
 *   const { content, usage } = await client.complete(messages, { json: true });
 *
 * DeepSeek's API is OpenAI-compatible, so this is a plain chat-completions call:
 * https://api-docs.deepseek.com/api/create-chat-completion
 *
 * Every failure is turned into a DeepSeekError whose message is safe to show a
 * user and whose `code` tells callers what happened. The API key is used for
 * the Authorization header and nowhere else — never logged, never returned.
 */

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_TIMEOUT_MS = 60_000;

// The value shipped in .env and .env.example. Treated as "no key", so a fresh
// checkout gets a clear message instead of an opaque 401 from DeepSeek.
const PLACEHOLDER_KEYS = new Set(['your_api_key_here', 'sk-your-key-here', 'changeme']);

export class DeepSeekError extends Error {
  /**
   * @param {'missing_api_key'|'timeout'|'network'|'auth'|'insufficient_balance'|'rate_limited'|'bad_request'|'api_error'|'invalid_response'} code
   * @param {string} message Safe to show to the user.
   * @param {{status?: number, retryAfterSeconds?: number, cause?: unknown}} [options]
   *        `status` is the HTTP status this app should answer the browser with.
   */
  constructor(code, message, { status = 502, retryAfterSeconds, cause } = {}) {
    super(message, { cause });
    this.name = 'DeepSeekError';
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class DeepSeekClient {
  #apiKey;
  #fetch;

  /**
   * @param {{apiKey?: string, baseUrl?: string, model?: string, timeoutMs?: number,
   *          maxTokens?: number, temperature?: number, fetchImpl?: typeof fetch, logger?: object}} [options]
   *        `fetchImpl` exists for tests.
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTokens, temperature, fetchImpl = globalThis.fetch, logger = null } = {}) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.#apiKey = PLACEHOLDER_KEYS.has(key) ? '' : key;
    this.#fetch = fetchImpl;
    this.endpoint = resolveEndpoint(baseUrl);
    this.provider = 'deepseek';
    this.model = model || DEFAULT_MODEL;
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.logger = logger;
  }

  /** Whether a key is present. The key itself is never exposed. */
  get configured() {
    return this.#apiKey.length > 0;
  }

  /**
   * Send a complete message array and return the answer.
   *
   * With `json: true` DeepSeek's JSON output mode is requested
   * (`response_format: {type: "json_object"}`); the prompt must then ask for
   * JSON, which the agent's prompt does.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {{json?: boolean, requestId?: string, taskId?: string}} [options] The ids only go to the log.
   * @returns {Promise<{content: string, model: string, finishReason: string|null,
   *   usage: {promptTokens: number|null, completionTokens: number|null, totalTokens: number|null}}>}
   * @throws {DeepSeekError}
   */
  async complete(messages, { json = false, requestId, taskId } = {}) {
    if (!this.configured) {
      throw new DeepSeekError('missing_api_key',
        'DeepSeek API key is missing. Set DEEPSEEK_API_KEY in the environment and restart the server.',
        { status: 503 });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new DeepSeekError('bad_request', 'Nothing to send to DeepSeek: the context is empty.', { status: 500 });
    }

    // Technical facts only: sizes, timings, token counts. Never the key, never the text.
    const started = Date.now();
    const log = { requestId, taskId, model: this.model, messages: messages.length };
    try {
      const result = await this.#send(messages, json);
      this.logger?.info('deepseek.request', {
        ...log, ms: Date.now() - started, finishReason: result.finishReason,
        promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens,
      });
      return result;
    } catch (err) {
      this.logger?.warn('deepseek.error', { ...log, ms: Date.now() - started, code: err.code, status: err.status });
      throw err;
    }
  }

  async #send(messages, json) {
    const payload = { model: this.model, messages, stream: false };
    if (json) payload.response_format = { type: 'json_object' };
    if (this.maxTokens) payload.max_tokens = this.maxTokens;
    if (this.temperature !== undefined) payload.temperature = this.temperature;

    const response = await this.#post(payload);
    const body = await this.#readJson(response);
    if (!response.ok) throw httpError(response, body);
    return parseCompletion(body, this.model);
  }

  async #post(payload) {
    try {
      return await this.#fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(payload),
        // Covers the whole exchange, body included — not just the connection.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw transportError(err, this.timeoutMs);
    }
  }

  async #readJson(response) {
    let text;
    try {
      text = await response.text();
    } catch (err) {
      throw transportError(err, this.timeoutMs);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      // A proxy error page, a captive portal, an HTML 502.
      if (!response.ok) return null;
      throw new DeepSeekError('invalid_response',
        `DeepSeek API returned a response that is not JSON (HTTP ${response.status}).`);
    }
  }
}

/** Accept a base URL (`https://api.deepseek.com`) or the full endpoint. */
export function resolveEndpoint(baseUrl) {
  const trimmed = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function transportError(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new DeepSeekError('timeout',
      `DeepSeek API did not answer within ${Math.round(timeoutMs / 1000)}s. Please try again.`,
      { status: 504, cause: err });
  }
  return new DeepSeekError('network', 'Unable to connect to DeepSeek API. Check the network and try again.',
    { status: 502, cause: err });
}

/** Map an HTTP failure onto something the user can act on. */
function httpError(response, body) {
  const status = response.status;
  const detail = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 300) : '';

  switch (true) {
    case status === 401 || status === 403:
      return new DeepSeekError('auth', 'DeepSeek API rejected the API key. Check DEEPSEEK_API_KEY.', { status: 502 });
    case status === 402:
      return new DeepSeekError('insufficient_balance', 'DeepSeek API returned an error: the account has insufficient balance.', { status: 502 });
    case status === 429: {
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
      return new DeepSeekError('rate_limited',
        `DeepSeek API is rate limiting requests. Please retry${retryAfterSeconds ? ` in ${retryAfterSeconds}s` : ' in a moment'}.`,
        { status: 429, retryAfterSeconds });
    }
    case status === 400 || status === 422:
      return new DeepSeekError('bad_request', `DeepSeek API returned an error: ${detail || `HTTP ${status}`}`, { status: 502 });
    default:
      return new DeepSeekError('api_error', `DeepSeek API returned an error (HTTP ${status}). Please try again.`, { status: 502 });
  }
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

function parseCompletion(body, fallbackModel) {
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new DeepSeekError('invalid_response', 'DeepSeek API returned a response without an answer.');
  }
  if (!content.trim()) {
    throw new DeepSeekError('invalid_response', 'DeepSeek API returned an empty answer. Please rephrase and try again.');
  }

  const usage = body.usage ?? {};
  return {
    content,
    model: typeof body.model === 'string' ? body.model : fallbackModel,
    finishReason: choice.finish_reason ?? null,
    // DeepSeek's own count from the tokenizer that actually ran — exact.
    usage: {
      promptTokens: count(usage.prompt_tokens),
      completionTokens: count(usage.completion_tokens),
      totalTokens: count(usage.total_tokens),
    },
  };
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The agent depends on this shape only:
 *
 *   {
 *     provider: string, model: string, configured: boolean,
 *     complete(messages, { json }) → Promise<{ content, model, finishReason,
 *                                              usage: { promptTokens, completionTokens, totalTokens } }>
 *   }
 *
 * and on errors that carry a user-safe `message`, an HTTP `status` and a
 * `code`. Another provider is added by implementing the same shape and adding
 * a case here.
 */
export function createLlmClient({ provider = 'deepseek', ...options }) {
  switch (provider) {
    case 'deepseek':
      return new DeepSeekClient(options);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
