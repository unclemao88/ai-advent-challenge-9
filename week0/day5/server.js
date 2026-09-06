'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Keys come from the environment. A .env file next to server.js is read first for
// local runs; anything already exported wins, so systemd's EnvironmentFile stays
// authoritative in production and the file may simply be absent there.
function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return;
  }
  raw.split('\n').forEach(line => {
    const text = line.trim();
    if (!text || text[0] === '#') return;
    const eq = text.indexOf('=');
    if (eq < 1) return;
    const key = text.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = text.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length > 1 && (quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    }
    if (!has(process.env, key)) process.env[key] = value;
  });
}

loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    hostname: 'api.deepseek.com',
    path: '/chat/completions',
    keyVar: 'DEEPSEEK_API_KEY'
  },
  openai: {
    label: 'OpenAI',
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    keyVar: 'OPENAI_API_KEY'
  }
};

// The switcher speaks in short names; the wire needs real model ids, so each name maps
// to one. Every mapping is overridable by an env var, so a rename at the provider — or
// a swap to a cheaper model — costs a restart rather than a code change.
//
// `supports` is what the model actually accepts. The options page is older than this
// switcher and offers controls the OpenAI models reject outright (a temperature other
// than 1, a stop list) or handle under a different parameter name, so anything not
// supported is dropped before the request goes out rather than coming back as a 400.
const MODELS = {
  flash: {
    label: 'DeepSeek Flash',
    provider: 'deepseek',
    id: process.env.DEEPSEEK_MODEL_FLASH || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    note: 'Fast general-purpose chat. Every option on this page applies.',
    supports: { jsonMode: true, temperature: true, stop: true, tokenParam: 'max_tokens' }
  },
  pro: {
    label: 'DeepSeek Pro',
    provider: 'deepseek',
    id: process.env.DEEPSEEK_MODEL_PRO || 'deepseek-reasoner',
    note: 'Reasoning model: it works the problem through before answering. Temperature is ignored and JSON is requested rather than enforced.',
    supports: { jsonMode: false, temperature: false, stop: true, tokenParam: 'max_tokens' }
  },
  luna: {
    label: 'OpenAI Luna',
    provider: 'openai',
    id: process.env.OPENAI_MODEL_LUNA || 'gpt-5-nano',
    note: 'Smallest and cheapest of the three. Reasoning tokens count against the response limit, so leave it room.',
    supports: { jsonMode: true, temperature: false, stop: false, tokenParam: 'max_completion_tokens' }
  },
  terra: {
    label: 'OpenAI Terra',
    provider: 'openai',
    id: process.env.OPENAI_MODEL_TERRA || 'gpt-5-mini',
    note: 'Mid tier: most of the quality at a fraction of the cost. Reasoning tokens count against the response limit.',
    supports: { jsonMode: true, temperature: false, stop: false, tokenParam: 'max_completion_tokens' }
  },
  sol: {
    label: 'OpenAI Sol',
    provider: 'openai',
    id: process.env.OPENAI_MODEL_SOL || 'gpt-5',
    note: 'The strongest and slowest option. Reasoning tokens count against the response limit.',
    supports: { jsonMode: true, temperature: false, stop: false, tokenParam: 'max_completion_tokens' }
  }
};

const DEFAULT_MODEL = has(MODELS, String(process.env.DEFAULT_MODEL)) ? process.env.DEFAULT_MODEL : 'flash';

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// Chat-completions APIs only enforce two response_format types: 'text' and
// 'json_object'. The richer formats below are steered with a system message instead, so
// they are a strong request rather than a guarantee. A model without a JSON mode
// (DeepSeek Pro) falls back to the same treatment for 'json'.
const FORMATS = {
  text: {
    responseFormat: 'text',
    instruction: null
  },
  json: {
    responseFormat: 'json_object',
    // json_object mode requires the word "json" somewhere in the prompt, or the API rejects it.
    instruction: 'Reply with a single valid json object and nothing else. No code fences, no commentary.'
  },
  markdown: {
    responseFormat: 'text',
    instruction: 'Reply in Markdown. Use headings, lists and code fences where they help. Do not wrap the whole answer in one code fence.'
  },
  xml: {
    responseFormat: 'text',
    instruction: 'Reply with a single well-formed XML document and nothing else. No code fences, no commentary.'
  },
  csv: {
    responseFormat: 'text',
    instruction: 'Reply with CSV and nothing else: a header row followed by data rows. Quote any field containing a comma, quote or newline. No code fences, no commentary.'
  }
};

// How the task is put to the model. 'meta' and 'roles' are multi-call and are
// handled by their own runners below; the other two are a single call whose
// system instruction is given here.
const TECHNIQUES = {
  simple: {
    label: 'Answer',
    instruction: null
  },
  cot: {
    label: 'Chain of thought',
    instruction: 'Solve the task by reasoning step by step. Number the steps, make each one follow from the '
      + 'previous, and close with a final line that states the conclusion on its own.'
  },
  meta: {
    label: 'Answer',
    instruction: null
  },
  roles: {
    label: 'Answer',
    instruction: null
  }
};

// Meta prompting, step one: the model writes the prompt instead of answering.
const META_BUILDER_INSTRUCTION = 'You are a prompt engineer. You will be given a task. Do not solve it. '
  + 'Write the single best prompt another language model could follow to solve it well: the role it should '
  + 'adopt, the steps to work through, what the answer must contain and how it should be structured. '
  + 'Reply with the prompt text only — no preamble, no commentary, no code fences.';

// Deliberate reasoning: the same task, once per selected point of view.
const ROLES = {
  engineer: {
    label: 'Engineer',
    instruction: 'Answer as a senior engineer. Focus on how the thing is actually built and operated: concrete '
      + 'mechanisms, trade-offs, failure modes, and the effort and maintenance it costs.'
  },
  analytic: {
    label: 'Analyst',
    instruction: 'Answer as an analyst. Break the task into its parts, work from data and stated assumptions, '
      + 'quantify what can be quantified and say plainly what cannot.'
  },
  critic: {
    label: 'Critic',
    instruction: 'Answer as a critic. Attack the task and the obvious answers to it: hidden assumptions, weak '
      + 'points, what would have to be true for it to hold, and what goes wrong first.'
  },
  teacher: {
    label: 'Teacher',
    instruction: 'Answer as a teacher. Build up from what a newcomer already knows, define every term you use, '
      + 'give a worked example, and end with the one idea worth remembering.'
  },
  lawyer: {
    label: 'Lawyer',
    instruction: 'Answer as a lawyer. Identify the rules, duties, liabilities and risks in play, separate what is '
      + 'settled from what is arguable, and note where jurisdiction or specific facts would change the answer. '
      + 'Speak in general terms; this is not legal advice.'
  },
  financier: {
    label: 'Financier',
    instruction: 'Answer as a financier. Follow the money: costs, revenue, capital needed, time horizon, downside, '
      + 'and the return that would justify it. State the assumption behind every number you give.'
  }
};

const MAX_TOKENS_LIMIT = 8192;
const MAX_STOP_SEQUENCES = 16;
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// Stop sequences are typed in a plain textarea, so let people write \n, \r, \t and \\.
function unescapeSequence(text) {
  return text.replace(/\\([nrt\\])/g, (match, code) => {
    if (code === 'n') return '\n';
    if (code === 'r') return '\r';
    if (code === 't') return '\t';
    return '\\';
  });
}

function parseOptions(body) {
  const modelKey = body.model === undefined || body.model === null || body.model === ''
    ? DEFAULT_MODEL
    : body.model;
  if (typeof modelKey !== 'string' || !has(MODELS, modelKey)) {
    throw badRequest('Unknown model: ' + String(modelKey));
  }
  const model = MODELS[modelKey];

  const format = body.format === undefined || body.format === null ? 'text' : body.format;
  if (typeof format !== 'string' || !has(FORMATS, format)) {
    throw badRequest('Unknown response format: ' + String(format));
  }

  const technique = body.technique === undefined || body.technique === null ? 'simple' : body.technique;
  if (typeof technique !== 'string' || !has(TECHNIQUES, technique)) {
    throw badRequest('Unknown prompt technique: ' + String(technique));
  }

  const roles = [];
  if (technique === 'roles') {
    if (!Array.isArray(body.roles)) {
      throw badRequest('Deliberate reasoning needs a "roles" array.');
    }
    body.roles.forEach(key => {
      if (typeof key !== 'string' || !has(ROLES, key)) {
        throw badRequest('Unknown role: ' + String(key));
      }
      if (roles.indexOf(key) === -1) roles.push(key);
    });
    if (!roles.length) {
      throw badRequest('Select at least one role for deliberate reasoning.');
    }
  }

  let maxTokens = null;
  if (body.maxTokens !== undefined && body.maxTokens !== null && body.maxTokens !== '') {
    maxTokens = Number(body.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_LIMIT) {
      throw badRequest('Response limit must be a whole number of tokens between 1 and ' + MAX_TOKENS_LIMIT + '.');
    }
  }

  // 0 is a meaningful temperature, so only undefined/null/'' mean "let the model decide".
  let temperature = null;
  if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
    temperature = Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < TEMPERATURE_MIN || temperature > TEMPERATURE_MAX) {
      throw badRequest('Temperature must be a number between '
        + TEMPERATURE_MIN.toFixed(1) + ' and ' + TEMPERATURE_MAX.toFixed(1) + '.');
    }
  }

  let stop = [];
  if (body.stop !== undefined && body.stop !== null && body.stop !== '') {
    if (!Array.isArray(body.stop)) {
      throw badRequest('Stop sequences must be sent as an array of strings.');
    }
    stop = body.stop
      .map(item => {
        if (typeof item !== 'string') throw badRequest('Every stop sequence must be a string.');
        return unescapeSequence(item);
      })
      .filter(item => item.length > 0);
    if (stop.length > MAX_STOP_SEQUENCES) {
      throw badRequest('At most ' + MAX_STOP_SEQUENCES + ' stop sequences are allowed.');
    }
  }

  // The page greys these out for a model that rejects them; drop them here as well, so
  // a stale tab or a direct API call cannot turn an unsupported option into a 400.
  if (!model.supports.temperature) temperature = null;
  if (!model.supports.stop) stop = [];

  return {
    modelKey: modelKey,
    model: model,
    format: format,
    technique: technique,
    roles: roles,
    maxTokens: maxTokens,
    temperature: temperature,
    stop: stop
  };
}

function apiKeyFor(model) {
  return process.env[PROVIDERS[model.provider].keyVar];
}

function callModel(model, messages, call) {
  const provider = PROVIDERS[model.provider];
  return new Promise((resolve, reject) => {
    const request = {
      model: model.id,
      messages: messages,
      stream: false,
      response_format: { type: call.responseFormat }
    };
    // Newer OpenAI models renamed max_tokens to max_completion_tokens and reject the old one.
    if (call.maxTokens) request[model.supports.tokenParam] = call.maxTokens;
    if (call.temperature != null) request.temperature = call.temperature;
    if (call.stop && call.stop.length) request.stop = call.stop;

    const payload = JSON.stringify(request);

    const req = https.request({
      hostname: provider.hostname,
      path: provider.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKeyFor(model),
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          return reject(new Error(provider.label + ' returned a non-JSON response (HTTP ' + res.statusCode + ')'));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = parsed && parsed.error && parsed.error.message
            ? parsed.error.message
            : 'HTTP ' + res.statusCode;
          return reject(new Error(provider.label + ' API error (' + model.id + '): ' + detail));
        }
        const choice = parsed.choices && parsed.choices[0];
        let text = choice && choice.message && choice.message.content;
        // A reasoning model that spends its whole budget thinking returns null content with
        // finish_reason 'length'. That is a truncated answer, not a broken response.
        if (text == null && choice && choice.finish_reason === 'length') text = '';
        // An empty string is a legitimate answer when a stop sequence matches immediately.
        if (typeof text !== 'string') {
          return reject(new Error(provider.label + ' response contained no message content'));
        }
        resolve({
          answer: text,
          finishReason: (choice && choice.finish_reason) || null,
          usage: parsed.usage || null
        });
      });
    });

    req.on('error', err => reject(new Error('Could not reach ' + provider.label + ': ' + err.message)));
    req.setTimeout(120000, () => {
      req.destroy(new Error('Request to ' + provider.label + ' timed out after 120s'));
    });
    req.end(payload);
  });
}

function buildMessages(instructions, prompt) {
  const messages = [];
  instructions.forEach(text => {
    if (text) messages.push({ role: 'system', content: text });
  });
  messages.push({ role: 'user', content: prompt });
  return messages;
}

// One solving call: technique or role instruction first, format instruction last so
// that the format wins when the two pull in different directions.
function solveOnce(id, label, instruction, prompt, options) {
  const spec = FORMATS[options.format];
  // Without a native JSON mode the instruction alone has to carry the format.
  const responseFormat = spec.responseFormat === 'json_object' && !options.model.supports.jsonMode
    ? 'text'
    : spec.responseFormat;
  return callModel(options.model, buildMessages([instruction, spec.instruction], prompt), {
    responseFormat: responseFormat,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stop: options.stop
  }).then(result => ({
    id: id,
    label: label,
    kind: 'answer',
    format: options.format,
    answer: result.answer,
    finishReason: result.finishReason,
    usage: result.usage
  }));
}

// Meta prompting: ask for a prompt, show it, then answer with it.
async function runMeta(prompt, options) {
  const built = await callModel(
    options.model,
    buildMessages([META_BUILDER_INSTRUCTION], 'Task:\n' + prompt),
    // The response format and stop sequences belong to the answer, not to the prompt
    // being written here — a stop sequence would happily cut the prompt in half.
    { responseFormat: 'text', maxTokens: options.maxTokens, temperature: options.temperature, stop: [] }
  );

  const generated = built.answer.trim();
  if (!generated) throw new Error('The prompt-building step came back empty.');

  const step = {
    id: 'meta-prompt',
    label: 'Generated prompt',
    kind: 'prompt',
    format: 'text',
    answer: generated,
    finishReason: built.finishReason,
    usage: built.usage
  };

  // The generated prompt does not always restate the task, so carry it along.
  const answer = await solveOnce('answer', 'Answer', null, generated + '\n\nTask:\n' + prompt, options);
  return [step, answer];
}

// Deliberate reasoning: the same task answered once per selected role, in parallel.
function runRoles(prompt, options) {
  return Promise.all(options.roles.map(key =>
    solveOnce(key, ROLES[key].label, ROLES[key].instruction, prompt, options)
      .catch(err => ({
        id: key,
        label: ROLES[key].label,
        kind: 'answer',
        format: options.format,
        answer: null,
        error: err.message
      }))
  )).then(results => {
    // A single role failing still leaves something worth showing; all of them failing does not.
    if (results.every(result => result.error)) {
      const err = new Error(results[0].error);
      err.status = 502;
      throw err;
    }
    return results;
  });
}

async function solve(prompt, options) {
  let results;
  if (options.technique === 'meta') {
    results = await runMeta(prompt, options);
  } else if (options.technique === 'roles') {
    results = await runRoles(prompt, options);
  } else {
    const technique = TECHNIQUES[options.technique];
    results = [await solveOnce('answer', technique.label, technique.instruction, prompt, options)];
  }
  return {
    technique: options.technique,
    format: options.format,
    model: options.modelKey,
    modelLabel: options.model.label,
    modelId: options.model.id,
    results: results
  };
}

// What the page needs to build the switcher: the labels, which options each model can
// take, and whether the provider's key is actually configured on this box.
function modelCatalogue() {
  return {
    default: DEFAULT_MODEL,
    models: Object.keys(MODELS).map(key => {
      const model = MODELS[key];
      const provider = PROVIDERS[model.provider];
      return {
        key: key,
        label: model.label,
        provider: provider.label,
        id: model.id,
        note: model.note,
        configured: Boolean(apiKeyFor(model)),
        keyVar: provider.keyVar,
        supports: {
          jsonMode: model.supports.jsonMode,
          temperature: model.supports.temperature,
          stop: model.supports.stop
        }
      };
    })
  };
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  if (filePath.indexOf(PUBLIC_DIR + path.sep) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/models') {
    return sendJson(res, 200, modelCatalogue());
  }

  if (req.method === 'POST' && req.url === '/api/ask') {
    try {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid JSON in request body.' });
      }
      if (!body || typeof body !== 'object') {
        return sendJson(res, 400, { error: 'Request body must be a JSON object.' });
      }
      const prompt = body.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return sendJson(res, 400, { error: 'Please enter a query.' });
      }
      const options = parseOptions(body);
      if (!apiKeyFor(options.model)) {
        return sendJson(res, 500, {
          error: PROVIDERS[options.model.provider].keyVar + ' is not set in the environment, so '
            + options.model.label + ' cannot be used.'
        });
      }
      const result = await solve(prompt.trim(), options);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log('Listening on http://' + HOST + ':' + PORT);
  Object.keys(PROVIDERS).forEach(name => {
    const provider = PROVIDERS[name];
    if (!process.env[provider.keyVar]) {
      console.warn('Warning: ' + provider.keyVar + ' is not set — ' + provider.label + ' models will fail.');
    }
  });
});

server.on('error', err => {
  console.error('Server error: ' + err.message);
  process.exit(1);
});

// systemd sends SIGTERM on stop/restart; finish in-flight requests, then exit.
let shuttingDown = false;
['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Received ' + signal + ', shutting down.');
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.error('Shutdown timed out, forcing exit.');
      process.exit(1);
    }, 15000).unref();
  });
});
