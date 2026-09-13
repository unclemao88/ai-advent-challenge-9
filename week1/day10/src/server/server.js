'use strict';

const path = require('path');
const express = require('express');

const loadConfig = require('../config');
const tokenService = require('../shared/tokenService');
const StateStore = require('../storage/stateStore').StateStore;
const DeepSeekClient = require('../agent/deepseekClient').DeepSeekClient;
const AgentError = require('../agent/errors').AgentError;
const ContextManager = require('../agent/contextManager').ContextManager;
const FactExtractor = require('../agent/factExtractor').FactExtractor;
const DeepSeekAgent = require('../agent/deepseekAgent').DeepSeekAgent;

const SECURITY_HEADERS = {
  // No inline scripts or styles anywhere, so the policy can be strict.
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

/** Wire the agent from configuration. */
function createAgent(config, store, logger) {
  const client = new DeepSeekClient({
    apiKey: config.deepseek.apiKey,
    apiUrl: config.deepseek.apiUrl,
    timeoutMs: config.deepseek.timeoutMs
  });
  return new DeepSeekAgent({
    client: client,
    store: store,
    contextManager: new ContextManager({
      tokenService: tokenService,
      contextLimitTokens: config.contextLimitTokens,
      maxOutputTokens: config.maxOutputTokens
    }),
    factExtractor: new FactExtractor({ client: client, model: config.deepseek.factsModel, tokenService: tokenService }),
    tokenService: tokenService,
    model: config.deepseek.model,
    factsModel: config.deepseek.factsModel,
    maxQuestionChars: config.maxQuestionChars,
    logger: logger
  });
}

/**
 * The HTTP surface. It validates the transport, calls the agent and maps
 * errors onto statuses; all behaviour lives in the agent.
 *
 * @param {{agent: DeepSeekAgent, config: {publicDir: string}, logger?: Console}} options
 */
function createApp(options) {
  const agent = options.agent;
  const logger = options.logger || console;

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(function (req, res, next) { res.set(SECURITY_HEADERS); next(); });
  app.use('/api', function (req, res, next) { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '64kb' }));

  app.use(express.static(options.config.publicDir));
  // The token estimator is shared source; nothing else under src/ is exposed.
  app.get('/shared/tokenService.js', function (req, res) {
    res.type('application/javascript').sendFile(path.join(__dirname, '..', 'shared', 'tokenService.js'));
  });

  app.get('/api/health', function (req, res) {
    res.json({ ok: true, agentConfigured: agent.configured, model: agent.model });
  });

  app.get('/api/state', function (req, res, next) {
    agent.getState().then(function (state) { res.json(state); }).catch(next);
  });

  app.post('/api/ask', function (req, res) {
    const started = Date.now();
    agent.ask(body(req).question).then(function (result) {
      logger.log('[http] POST /api/ask 200 in ' + (Date.now() - started) + 'ms');
      res.json(result);
    }).catch(function (err) { sendError(res, err, 'POST /api/ask', logger); });
  });

  app.post('/api/context', function (req, res) {
    agent.updateContext(body(req)).then(function (out) {
      res.json({ changed: out.result, state: out.state });
    }).catch(function (err) { sendError(res, err, 'POST /api/context', logger); });
  });

  app.post('/api/checkpoint', function (req, res) {
    agent.createCheckpoint().then(function (out) {
      logger.log('[http] checkpoint created: ' + out.result.id);
      res.json({ checkpoint: out.result, state: out.state });
    }).catch(function (err) { sendError(res, err, 'POST /api/checkpoint', logger); });
  });

  app.post('/api/branch/switch', function (req, res) {
    agent.switchBranch(body(req).branchId).then(function (out) {
      res.json({ branch: out.result, state: out.state });
    }).catch(function (err) { sendError(res, err, 'POST /api/branch/switch', logger); });
  });

  app.post('/api/checkpoint/delete', function (req, res) {
    agent.deleteCheckpoint(body(req).branchId).then(function (out) {
      logger.log('[http] checkpoint deleted, removed ' + out.result.removedBranchId + ' (' + out.result.removedMessages + ' messages)');
      res.json({ deleted: out.result, state: out.state });
    }).catch(function (err) { sendError(res, err, 'POST /api/checkpoint/delete', logger); });
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

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function sendError(res, err, route, logger) {
  const known = err instanceof AgentError;
  if (known && err.status < 500 && err.status !== 429) {
    logger.warn('[http] ' + route + ' ' + err.status + ': ' + err.message);
  } else {
    logger.error('[http] ' + route + ' failed:', known ? (err.detail || err.message) : err);
  }
  res.status(known ? err.status : 500).json({
    error: known ? err.message : 'Something went wrong on the server. Please try again.'
  });
}

async function start() {
  const config = loadConfig();
  const store = new StateStore({ dataDir: config.dataDir });
  try {
    await store.init();
  } catch (err) {
    console.error('Cannot use data directory ' + config.dataDir + ': ' + err.message);
    process.exit(1);
  }

  const agent = createAgent(config, store);
  const app = createApp({ agent: agent, config: config });

  console.log('Agent: DeepSeek ' + config.deepseek.model + ' (facts: ' + config.deepseek.factsModel + ')');
  console.log('Context limit: ' + config.contextLimitTokens + ' tokens, output reserve ' + config.maxOutputTokens);
  if (!agent.configured) console.warn('DEEPSEEK_API_KEY is not set: the UI loads, but questions get HTTP 503.');
  console.log('State: ' + store.file);

  const server = app.listen(config.port, config.host, function () {
    console.log('Listening on http://' + config.host + ':' + config.port);
  });
  // A turn can mean several DeepSeek calls; Node 10's 2-minute socket timeout
  // would cut long ones off.
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
