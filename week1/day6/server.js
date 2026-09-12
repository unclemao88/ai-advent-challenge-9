'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const loadEnvFile = require('./lib/load-env');
const agentModule = require('./agent');
const createAgent = agentModule.createAgent;
const AgentError = agentModule.AgentError;

loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// Built once at startup so a misconfiguration fails visibly here rather than
// on the first question. Nothing below this line mentions DeepSeek.
let agent = null;
let agentError = null;
try {
  agent = createAgent();
  console.log('Agent: ' + agent.describe());
} catch (err) {
  agentError = err.message;
  console.error('Agent unavailable: ' + err.message);
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
  return new Promise(function (resolve, reject) {
    let raw = '';
    req.on('data', function (chunk) {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('Question is too long.'));
        req.destroy();
      }
    });
    req.on('end', function () { resolve(raw); });
    req.on('error', reject);
  });
}

async function handleAsk(req, res) {
  if (!agent) {
    return sendJson(res, 503, { error: 'The agent is not configured on the server: ' + agentError });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, 400, { error: 'Invalid request body.' });
  }

  const question = body && typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return sendJson(res, 400, { error: 'Please enter a question.' });
  }

  try {
    const answer = await agent.ask(question);
    return sendJson(res, 200, { answer: answer });
  } catch (err) {
    if (err instanceof AgentError) {
      return sendJson(res, err.status, { error: err.message });
    }
    // An unexpected throw could carry internals; log it, show something plain.
    console.error('Unexpected agent failure:', err);
    return sendJson(res, 500, { error: 'The agent failed unexpectedly. Please try again.' });
  }
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  if (filePath.indexOf(PUBLIC_DIR + path.sep) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, function (err, buf) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(function (req, res) {
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/ask') {
    return handleAsk(req, res);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
});

server.listen(PORT, HOST, function () {
  console.log('Listening on http://' + HOST + ':' + PORT);
});

server.on('error', function (err) {
  console.error('Server error: ' + err.message);
  process.exit(1);
});

// systemd sends SIGTERM on stop/restart; finish in-flight requests, then exit.
let shuttingDown = false;
['SIGTERM', 'SIGINT'].forEach(function (signal) {
  process.on(signal, function () {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Received ' + signal + ', shutting down.');
    server.close(function () { process.exit(0); });
    setTimeout(function () {
      console.error('Shutdown timed out, forcing exit.');
      process.exit(1);
    }, 15000).unref();
  });
});
