'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// DeepSeek's API only enforces two response_format types: 'text' and 'json_object'.
// The richer formats below are steered with a system message instead, so they are a
// strong request rather than a guarantee.
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

const MAX_TOKENS_LIMIT = 8192;
const MAX_STOP_SEQUENCES = 16;

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
  const format = body.format === undefined || body.format === null ? 'text' : body.format;
  if (typeof format !== 'string' || !Object.prototype.hasOwnProperty.call(FORMATS, format)) {
    throw badRequest('Unknown response format: ' + String(format));
  }

  let maxTokens = null;
  if (body.maxTokens !== undefined && body.maxTokens !== null && body.maxTokens !== '') {
    maxTokens = Number(body.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_LIMIT) {
      throw badRequest('Response limit must be a whole number of tokens between 1 and ' + MAX_TOKENS_LIMIT + '.');
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

  return { format: format, maxTokens: maxTokens, stop: stop };
}

function askDeepseek(prompt, options) {
  return new Promise((resolve, reject) => {
    const spec = FORMATS[options.format];
    const messages = [];
    if (spec.instruction) messages.push({ role: 'system', content: spec.instruction });
    messages.push({ role: 'user', content: prompt });

    const request = {
      model: MODEL,
      messages: messages,
      stream: false,
      response_format: { type: spec.responseFormat }
    };
    if (options.maxTokens) request.max_tokens = options.maxTokens;
    if (options.stop.length) request.stop = options.stop;

    const payload = JSON.stringify(request);

    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
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
          return reject(new Error('DeepSeek returned a non-JSON response (HTTP ' + res.statusCode + ')'));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = parsed && parsed.error && parsed.error.message
            ? parsed.error.message
            : 'HTTP ' + res.statusCode;
          return reject(new Error('DeepSeek API error: ' + detail));
        }
        const choice = parsed.choices && parsed.choices[0];
        const text = choice && choice.message && choice.message.content;
        // An empty string is a legitimate answer when a stop sequence matches immediately.
        if (typeof text !== 'string') return reject(new Error('DeepSeek response contained no message content'));
        resolve({
          answer: text,
          format: options.format,
          finishReason: (choice && choice.finish_reason) || null,
          usage: parsed.usage || null
        });
      });
    });

    req.on('error', err => reject(new Error('Could not reach DeepSeek: ' + err.message)));
    req.setTimeout(120000, () => {
      req.destroy(new Error('Request to DeepSeek timed out after 120s'));
    });
    req.end(payload);
  });
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
  if (req.method === 'POST' && req.url === '/api/ask') {
    if (!API_KEY) {
      return sendJson(res, 500, { error: 'DEEPSEEK_API_KEY is not set in the environment.' });
    }
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
      const result = await askDeepseek(prompt.trim(), options);
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
  if (!API_KEY) console.warn('Warning: DEEPSEEK_API_KEY is not set — requests will fail.');
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
