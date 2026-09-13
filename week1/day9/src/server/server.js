'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const loadConfig = require('../config');
const tokenService = require('../services/tokenService');
const HistoryStore = require('../storage/historyStore').HistoryStore;
const clientModule = require('../agent/deepseekClient');
const SummaryService = require('../services/summaryService').SummaryService;
const DeepSeekAgent = require('../agent/deepseekAgent').DeepSeekAgent;

const AgentError = clientModule.AgentError;

// Browser builds of the Markdown renderer and sanitizer, served from node_modules.
const VENDOR = {
  'marked.min.js': ['marked', 'marked.min.js'],
  'purify.min.js': ['dompurify', 'dist', 'purify.min.js']
};

const SECURITY_HEADERS = {
  // No inline scripts or styles anywhere, so the policy can be strict. Images
  // are same-origin only: a Markdown image in an answer cannot phone home.
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

/** Wire the agent from configuration. */
function createAgent(config, store) {
  const client = new clientModule.DeepSeekClient({
    apiKey: config.deepseek.apiKey,
    apiUrl: config.deepseek.apiUrl,
    timeoutMs: config.deepseek.timeoutMs
  });
  return new DeepSeekAgent({
    client: client,
    store: store,
    summaryService: new SummaryService({ client: client, model: config.deepseek.summaryModel, tokenService: tokenService }),
    tokenService: tokenService,
    model: config.deepseek.model,
    maxQuestionChars: config.maxQuestionChars
  });
}

/**
 * The HTTP surface. Kept free of DeepSeek and file details: it validates the
 * transport, calls the agent, and maps errors onto statuses.
 *
 * @param {{agent: DeepSeekAgent, config: object, logger?: Console}} options
 */
function createApp(options) {
  const agent = options.agent;
  const config = options.config;
  const logger = options.logger || console;

  const app = express();
  app.disable('x-powered-by');
  // No endpoint takes nested query objects; the simple parser keeps qs (and its
  // advisories) off the request path. Bodies are JSON only.
  app.set('query parser', 'simple');
  app.use(function (req, res, next) { res.set(SECURITY_HEADERS); next(); });
  app.use('/api', function (req, res, next) { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '64kb' }));

  app.use(express.static(config.publicDir));

  // The token service is shared source; nothing else under src/ is exposed.
  app.get('/shared/tokenService.js', function (req, res) {
    res.type('application/javascript').sendFile(path.join(__dirname, '..', 'services', 'tokenService.js'));
  });
  app.get('/vendor/:file', function (req, res, next) {
    const parts = VENDOR[req.params.file];
    if (!parts) return next();
    res.type('application/javascript').sendFile(path.join.apply(path, [config.root, 'node_modules'].concat(parts)));
  });

  app.get('/api/health', function (req, res) {
    res.json({ ok: true, agentConfigured: agent.configured, model: agent.model, windowSize: agent.windowSize });
  });

  app.get('/api/history', function (req, res, next) {
    agent.getMemory().then(function (memory) {
      res.json(Object.assign({ agentConfigured: agent.configured, maxQuestionChars: agent.maxQuestionChars }, memory));
    }).catch(next);
  });

  app.post('/api/ask', function (req, res) {
    const question = req.body && typeof req.body === 'object' ? req.body.question : undefined;
    const started = Date.now();

    agent.ask(question).then(function (result) {
      logger.log('[http] POST /api/ask 200 in ' + (Date.now() - started) + 'ms');
      res.json(result);
    }).catch(function (err) {
      const known = err instanceof AgentError;
      if (known && err.status < 500 && err.status !== 429) {
        logger.warn('[http] POST /api/ask ' + err.status + ': ' + err.message);
      } else {
        logger.error('[http] POST /api/ask failed after ' + (Date.now() - started) + 'ms:', known ? (err.detail || err.message) : err);
      }
      res.status(known ? err.status : 500).json({
        error: known ? err.message : 'Something went wrong on the server. Please try again.',
        // Present when the question had been stored before the failure.
        userMessage: err.userMessage || null,
        memory: err.memory || null
      });
    });
  });

  app.post('/api/history/clear', function (req, res, next) {
    if (!req.body || req.body.confirm !== true) {
      return res.status(400).json({ error: 'Clearing the history needs {"confirm": true}.' });
    }
    agent.clear().then(function (memory) {
      logger.log('[http] history cleared');
      res.json({ cleared: true, memory: memory });
    }).catch(next);
  });

  app.use('/api', function (req, res) {
    res.status(404).json({ error: 'Not found.' });
  });

  // Full details in the log, one plain sentence to the browser.
  app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
    const badBody = err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large');
    if (!badBody) logger.error('[http] ' + req.method + ' ' + req.path + ' failed:', err);
    if (res.headersSent) return;
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    res.status(badBody ? 400 : 500).json({
      error: badBody ? 'Invalid JSON in request body.' : 'Something went wrong on the server. Please try again.'
    });
  });

  return app;
}

async function start() {
  const config = loadConfig();
  const store = new HistoryStore({ dataDir: config.dataDir });
  try {
    await store.init();
  } catch (err) {
    console.error('Cannot use data directory ' + config.dataDir + ': ' + err.message);
    process.exit(1);
  }

  const agent = createAgent(config, store);
  const app = createApp({ agent: agent, config: config });

  Object.keys(VENDOR).forEach(function (file) {
    const full = path.join.apply(path, [config.root, 'node_modules'].concat(VENDOR[file]));
    if (!fs.existsSync(full)) console.warn('Missing ' + full + ' — run npm install. Answers will show as plain text.');
  });

  console.log('Agent: DeepSeek ' + config.deepseek.model + ' (summaries: ' + config.deepseek.summaryModel + ')');
  if (!agent.configured) console.warn('DEEPSEEK_API_KEY is not set: history is served, but questions get HTTP 503.');
  console.log('Memory: ' + store.historyFile + ', ' + store.summaryFile);

  const server = app.listen(config.port, config.host, function () {
    console.log('Listening on http://' + config.host + ':' + config.port);
  });
  // One turn can mean up to three DeepSeek calls; Node 10's 2-minute socket
  // timeout would cut long ones off.
  server.setTimeout(10 * 60 * 1000);
  server.on('error', function (err) {
    console.error('Server error: ' + err.message);
    process.exit(1);
  });

  let stopping = false;
  ['SIGTERM', 'SIGINT'].forEach(function (signal) {
    process.on(signal, function () {
      if (stopping) return;
      stopping = true;
      console.log('Received ' + signal + ', finishing open requests.');
      server.close(function () { process.exit(0); });
      setTimeout(function () {
        console.error('Shutdown timed out, forcing exit.');
        process.exit(1);
      }, 15000).unref();
    });
  });
}

if (require.main === module) start();

module.exports = { createApp, createAgent, start };
