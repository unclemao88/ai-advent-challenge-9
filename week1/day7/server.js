'use strict';

const path = require('path');
const express = require('express');

const loadEnvFile = require('./lib/load-env');
loadEnvFile(path.join(__dirname, '.env'));

const storage = require('./storage/chatStorage');
const agentModule = require('./agent/deepseekAgent');
const AgentError = agentModule.AgentError;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_QUESTION_CHARS = 8000;

// Built once at startup so a missing key fails visibly here, with a clear log
// line, rather than on the first question.
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
app.use(express.static(path.join(__dirname, 'public')));

/** The whole stored conversation, oldest first. */
app.get('/api/history', function (req, res, next) {
  storage.loadMessages().then(function (messages) {
    res.json({ messages: messages });
  }).catch(next);
});

/**
 * Ask a question. The exchange is treated as one operation: DeepSeek is called
 * first and both messages are appended in a single write, so a failed call
 * cannot leave a question in the history with no answer under it.
 */
app.post('/api/ask', function (req, res, next) {
  if (!agent) {
    return res.status(503).json({ error: 'The agent is not configured on the server: ' + agentError });
  }

  const body = req.body;
  const raw = body && typeof body.question === 'string' ? body.question.trim() : '';
  if (!raw) {
    return res.status(400).json({ error: 'Please enter a question.' });
  }
  if (raw.length > MAX_QUESTION_CHARS) {
    return res.status(413).json({
      error: 'That question is too long (limit ' + MAX_QUESTION_CHARS + ' characters).'
    });
  }

  // Only the text is taken from the request; id, timestamp, tag and role are
  // ours. The clock is read now so the question is stamped when it was asked.
  const askedAt = new Date();

  storage.loadMessages().then(function (history) {
    return agent.ask(raw, history);
  }).then(function (answer) {
    const userMessage = storage.createMessage('user', raw, askedAt);
    const assistantMessage = storage.createMessage('assistant', answer);
    return storage.appendMessages([userMessage, assistantMessage]).then(function () {
      res.json({ userMessage: userMessage, assistantMessage: assistantMessage });
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

// Anything unexpected is logged in full on the server and reported as one
// plain sentence to the browser, so no stack trace or config can leak out.
app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('Unexpected failure on ' + req.method + ' ' + req.path + ':', err);
  if (res.headersSent) return;
  const status = err && err.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({
    error: status === 400 ? 'Invalid request body.' : 'Something went wrong on the server. Please try again.'
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
  console.error('Could not open the history file: ' + err.message);
  process.exit(1);
});
