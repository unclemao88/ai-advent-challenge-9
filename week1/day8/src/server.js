'use strict';

const path = require('path');
const express = require('express');

const loadEnvFile = require('./utils/loadEnv');
loadEnvFile(path.join(__dirname, '..', '.env'));

const storage = require('./storage/historyStorage');
const tokenCounter = require('./utils/tokenCounter');
const agentModule = require('./agent/deepseekAgent');
const AgentError = agentModule.AgentError;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_QUESTION_CHARS = 8000;

// Built once at startup, so a missing key fails visibly here with a clear log
// line rather than on the first question. The key stays in this process: it is
// never sent to the browser, logged, or included in an error response.
let agent = null;
let agentError = null;
try {
  agent = agentModule.createAgent();
  console.log('Agent: ' + agent.describe());
} catch (err) {
  agentError = err.message;
  console.error('Agent unavailable: ' + err.message);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use(express.static(PUBLIC_DIR));

// The token counter is shared source: the browser loads the very same file the
// server counts with, so the "Current request" figure and the stored figure can
// never drift apart. Served explicitly — nothing else under src/ is exposed.
app.get('/shared/tokenCounter.js', function (req, res) {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'utils', 'tokenCounter.js'));
});

/**
 * GET /api/history
 * The whole stored conversation, oldest first, plus its total token count.
 */
app.get('/api/history', function (req, res, next) {
  storage.loadHistory().then(function (history) {
    res.json({
      messages: history.messages,
      historyTokenCount: tokenCounter.sumStoredTokens(history.messages),
      updatedAt: history.updatedAt
    });
  }).catch(next);
});

/**
 * POST /api/ask  { question }
 *
 * The exchange is one operation: DeepSeek is called first, then both messages
 * are appended in a single atomic write. A failed call therefore cannot leave a
 * question stranded in the history with no answer under it, and never invents a
 * reply — the caller gets an error status and the history is untouched.
 */
app.post('/api/ask', function (req, res, next) {
  if (!agent) {
    return res.status(503).json({ error: 'The agent is not configured on the server: ' + agentError });
  }

  const body = req.body;
  const question = body && typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return res.status(400).json({ error: 'Please enter a question.' });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return res.status(413).json({
      error: 'That question is too long (limit ' + MAX_QUESTION_CHARS + ' characters).'
    });
  }

  // Only the text comes from the request; id, type, tag, role and timestamp are
  // ours. The clock is read now so the question is stamped when it was asked,
  // not when the answer came back.
  const askedAt = new Date();

  storage.loadMessages().then(function (history) {
    return agent.ask(question, history).then(function (result) {
      const requestMessage = storage.createMessage('user', question, { when: askedAt });
      const responseMessage = storage.createMessage('assistant', result.answer, {
        // DeepSeek reports exactly how many tokens it generated; prefer that
        // over our estimate. Without it, createMessage falls back to the
        // estimator and marks the message as such.
        tokenCount: result.usage.completionTokens,
        tokenSource: 'api'
      });

      return storage.appendMessages([requestMessage, responseMessage]).then(function (stored) {
        console.log('Answered in ' + (Date.now() - askedAt.getTime()) + 'ms; '
          + 'context: ' + result.contextMessageCount + ' past messages, '
          + 'prompt tokens: ' + (result.usage.promptTokens === null ? 'n/a' : result.usage.promptTokens));

        res.json({
          request: requestMessage,
          response: responseMessage,
          historyTokenCount: stored.historyTokenCount,
          // Context reporting, so the UI can show that memory was really used.
          context: {
            replayedMessages: result.contextMessageCount,
            promptTokens: result.usage.promptTokens,
            totalTokens: result.usage.totalTokens,
            model: result.model
          }
        });
      });
    });
  }).catch(function (err) {
    if (err instanceof AgentError) {
      console.error('Agent error (' + err.status + '): ' + err.message);
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  });
});

app.use('/api', function (req, res) {
  res.status(404).json({ error: 'Not found.' });
});

// Anything unexpected is logged in full on the server and reported as one plain
// sentence to the browser, so no stack trace, path or configuration leaks out.
app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('Unexpected failure on ' + req.method + ' ' + req.path + ':', err);
  if (res.headersSent) return;
  const badJson = err && (err.type === 'entity.parse.failed' || err.status === 400);
  res.status(badJson ? 400 : 500).json({
    error: badJson
      ? 'Invalid request body.'
      : 'Something went wrong on the server. Please try again.'
  });
});

storage.init().then(function () {
  console.log('History: ' + storage.HISTORY_FILE);

  const server = app.listen(PORT, HOST, function () {
    console.log('Listening on http://' + HOST + ':' + PORT);
  });

  server.on('error', function (err) {
    console.error('Server error: ' + err.message);
    process.exit(1);
  });

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
}).catch(function (err) {
  // A corrupt history.json lands here: say so plainly instead of starting up
  // with an empty memory and silently overwriting the conversation.
  console.error('Could not open ' + storage.RELATIVE_NAME + ': ' + err.message);
  process.exit(1);
});
