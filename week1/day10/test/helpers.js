'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

const tokenService = require('../src/shared/tokenService');
const StateStore = require('../src/storage/stateStore').StateStore;
const ContextManager = require('../src/agent/contextManager').ContextManager;
const FactExtractor = require('../src/agent/factExtractor').FactExtractor;
const DeepSeekAgent = require('../src/agent/deepseekAgent').DeepSeekAgent;
const AgentError = require('../src/agent/errors').AgentError;

const quietLogger = { log() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-day10-'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Stands in for DeepSeekClient in agent tests (the real client is tested
 * against a local HTTP server in client.test.js).
 *
 * Answers echo the question. The fact extractor reads `key=value` pairs from
 * the user messages of the transcript it is given and returns them as
 * factsToSet — enough to prove what flows into and out of the facts.
 */
class FakeClient {
  constructor() {
    this.configured = true;
    this.calls = [];
    this.failAnswers = 0;      // Fail the next N answer calls.
    this.factsMode = 'ok';     // 'ok' | 'invalid-json' | 'throw'
  }

  async chat(request) {
    this.calls.push(JSON.parse(JSON.stringify(request)));
    const usage = (input, output) => ({ input: input, output: output, total: input + output, reasoning: null });

    if (isFactsCall(request)) {
      if (this.factsMode === 'throw') throw new AgentError('facts service down');
      if (this.factsMode === 'invalid-json') {
        return { content: 'Sure! The user is called John.', finishReason: 'stop', model: 'fake', usage: usage(200, 8) };
      }
      const transcript = /<<<\n([\s\S]*)\n>>>/.exec(request.messages[1].content)[1];
      const set = {};
      transcript.split(/\n\n(?=\[#\d+ )/).forEach(function (block) {
        if (!/^\[#\d+ user/.test(block)) return;
        const re = /\b([a-z_]+)=([^\s,]+)/g;
        let m;
        while ((m = re.exec(block))) set[m[1]] = m[2];
      });
      return { content: JSON.stringify({ factsToSet: set, factsToRemove: [] }), finishReason: 'stop', model: 'fake', usage: usage(300, 20) };
    }

    if (this.failAnswers > 0) {
      this.failAnswers -= 1;
      throw new AgentError('DeepSeek is unavailable right now (HTTP 503). Please try again.', 502);
    }
    const last = request.messages[request.messages.length - 1].content;
    return { content: 'answer to: ' + last, finishReason: 'stop', model: 'fake-chat', usage: usage(100 + request.messages.length, 7) };
  }

  answerCalls() {
    return this.calls.filter((c) => !isFactsCall(c));
  }

  factCalls() {
    return this.calls.filter(isFactsCall);
  }
}

function isFactsCall(request) {
  return /memory module/.test(request.messages[0].content);
}

async function makeAgent(options) {
  const opts = options || {};
  const dir = opts.dir || tempDir();
  const store = new StateStore({ dataDir: dir, logger: quietLogger });
  await store.init();
  const client = opts.client || new FakeClient();
  const agent = new DeepSeekAgent({
    client: client,
    store: store,
    contextManager: new ContextManager({
      tokenService: tokenService,
      contextLimitTokens: opts.contextLimitTokens || 64000,
      maxOutputTokens: opts.maxOutputTokens || 4096
    }),
    factExtractor: new FactExtractor({ client: client, model: 'fake-facts', tokenService: tokenService }),
    tokenService: tokenService,
    model: 'fake-chat',
    maxQuestionChars: opts.maxQuestionChars || 8000,
    logger: quietLogger
  });
  return { agent: agent, store: store, client: client, dir: dir, file: store.file };
}

async function askMany(agent, questions) {
  for (const q of questions) await agent.ask(q);
}

/** The stored history in a chat call: everything between the system prompt and the question. */
function historyOf(call) {
  return call.messages.slice(1, -1).map(function (m) { return m.content; });
}

function contents(messages) {
  return messages.map(function (m) { return m.content; });
}

function factsObject(publicState) {
  const out = {};
  publicState.contextManagement.stickyFacts.facts.forEach(function (f) { out[f.key] = f.value; });
  return out;
}

function range(n) {
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push(i);
  return out;
}

function listen(app) {
  return new Promise(function (resolve) {
    const server = app.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

/** Minimal HTTP client (Node 10 has no fetch). */
function request(server, method, urlPath, body, rawBody) {
  return new Promise(function (resolve, reject) {
    const payload = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
    const headers = payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: method, path: urlPath, headers: headers }, function (res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(data); } catch (err) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: data, body: json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

module.exports = {
  quietLogger, tempDir, readJson, FakeClient, makeAgent, askMany, historyOf, contents, factsObject, range, listen, request
};
