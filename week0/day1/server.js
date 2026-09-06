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

function askDeepseek(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false
    });

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
        if (!text) return reject(new Error('DeepSeek response contained no message content'));
        resolve(text);
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
      let prompt;
      try {
        prompt = JSON.parse(raw).prompt;
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid JSON in request body.' });
      }
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return sendJson(res, 400, { error: 'Please enter a query.' });
      }
      const answer = await askDeepseek(prompt.trim());
      return sendJson(res, 200, { answer: answer });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
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
