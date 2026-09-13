'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tokenService = require('../src/services/tokenService');
const HistoryStore = require('../src/storage/historyStore').HistoryStore;
const SummaryService = require('../src/services/summaryService').SummaryService;
const DeepSeekAgent = require('../src/agent/deepseekAgent').DeepSeekAgent;
const AgentError = require('../src/agent/deepseekClient').AgentError;

const quietLogger = { log() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-day9-'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Stands in for DeepSeekClient. Answers echo the question; the "summarizer"
 * concatenates the existing summary with the new message contents, which is
 * enough to prove what flows into and out of the summary.
 */
class FakeClient {
  constructor() {
    this.configured = true;
    this.calls = [];
    this.failAnswers = 0;   // Fail the next N answer calls.
    this.failSummaries = 0; // Fail the next N summary calls.
    this.noUsage = false;
  }

  async chat(request) {
    this.calls.push(request);
    const isSummary = /memory module/.test(request.messages[0].content);
    const usage = (input, output) => this.noUsage
      ? { input: null, output: null, total: null, reasoning: null }
      : { input: input, output: output, total: input + output, reasoning: null };

    if (isSummary) {
      if (this.failSummaries > 0) {
        this.failSummaries -= 1;
        throw new AgentError('summary service down');
      }
      const prompt = request.messages[1].content;
      const existing = /<<<\n([\s\S]*?)\n>>>/.exec(prompt)[1];
      const contents = [];
      const re = /\[#\d+ (user|assistant) · [^\]]+\]\n([^\n]*)/g;
      let m;
      while ((m = re.exec(prompt))) contents.push(m[2]);
      const base = /^\(empty/.test(existing) ? '' : existing + ' | ';
      return { content: base + contents.join(' | '), finishReason: 'stop', model: 'fake', usage: usage(300, 25) };
    }

    if (this.failAnswers > 0) {
      this.failAnswers -= 1;
      throw new AgentError('DeepSeek is unavailable right now (HTTP 503). Please try again.', 502);
    }
    const last = request.messages[request.messages.length - 1].content;
    return { content: 'answer to: ' + last, finishReason: 'stop', model: 'fake', usage: usage(120, 9) };
  }

  answerCalls() {
    return this.calls.filter((c) => !/memory module/.test(c.messages[0].content));
  }

  summaryCalls() {
    return this.calls.filter((c) => /memory module/.test(c.messages[0].content));
  }
}

async function makeAgent(options) {
  const opts = options || {};
  const dir = opts.dir || tempDir();
  const store = new HistoryStore({ dataDir: dir, logger: quietLogger });
  await store.init();
  const client = opts.client || new FakeClient();
  const agent = new DeepSeekAgent({
    client: client,
    store: store,
    summaryService: new SummaryService({ client: client, model: 'fake-summary', tokenService: tokenService }),
    tokenService: tokenService,
    model: 'fake-chat',
    maxQuestionChars: opts.maxQuestionChars || 8000,
    logger: quietLogger
  });
  return { agent, store, client, dir };
}

module.exports = { quietLogger, tempDir, readJson, FakeClient, makeAgent };
