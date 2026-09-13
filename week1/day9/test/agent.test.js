'use strict';

const assert = require('assert');

const test = require('./harness').test;
const h = require('./helpers');

async function turns(agent, count, prefix) {
  const results = [];
  for (let i = 1; i <= count; i += 1) results.push(await agent.ask((prefix || 'question ') + i));
  return results;
}

test('first question: context is system prompt + the question, exchange stored', async () => {
  const { agent, client, store } = await h.makeAgent();
  const result = await agent.ask('What is Docker?');

  const sent = client.answerCalls()[0].messages;
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].role, 'system');
  assert.ok(sent[0].content.indexOf('[Historical Summary]') !== -1);
  assert.ok(sent[0].content.indexOf('[Current User Question]') !== -1);
  assert.deepStrictEqual(sent[1], { role: 'user', content: 'What is Docker?' });

  assert.strictEqual(result.answer, 'answer to: What is Docker?');
  assert.strictEqual(result.message.tag, 'agent answered');
  const history = h.readJson(store.historyFile).messages;
  assert.deepStrictEqual(history.map((m) => m.role), ['user', 'assistant']);
});

test('context holds exactly the last 10 previous messages, verbatim, and the question once', async () => {
  const { agent, client } = await h.makeAgent();
  await turns(agent, 7); // 14 messages stored
  await agent.ask('zebra-marker question');

  const sent = client.answerCalls()[7].messages;
  const turnsSent = sent.slice(1);
  assert.strictEqual(turnsSent.length, 11, '10 recent messages + current question');
  assert.strictEqual(turnsSent[0].content, 'question 3', 'oldest recent message is #5');
  assert.strictEqual(turnsSent[9].content, 'answer to: question 7');
  assert.strictEqual(turnsSent[10].content, 'zebra-marker question');
  const occurrences = sent.filter((m) => m.content.indexOf('zebra-marker') !== -1).length;
  assert.strictEqual(occurrences, 1, 'not duplicated');
});

test('messages leaving the window are folded into the summary incrementally; originals kept', async () => {
  const { agent, client, store } = await h.makeAgent();
  await turns(agent, 5); // 10 messages: no summary needed
  assert.strictEqual(client.summaryCalls().length, 0);
  assert.strictEqual(h.readJson(store.summaryFile).messagesCovered, 0);

  const sixth = await agent.ask('question 6'); // 12 messages: 2 leave the window
  assert.strictEqual(client.summaryCalls().length, 1);
  let summary = h.readJson(store.summaryFile);
  assert.strictEqual(summary.messagesCovered, 2);
  assert.strictEqual(summary.summary, 'question 1 | answer to: question 1');
  assert.strictEqual(sixth.tokens.summarization.calls, 1);
  assert.strictEqual(sixth.memory.messages.length, 10);
  assert.strictEqual(sixth.memory.messages[0].content, 'question 2');

  await agent.ask('question 7'); // 14 messages: 2 more leave
  assert.strictEqual(client.summaryCalls().length, 2);
  const prompt = client.summaryCalls()[1].messages[1].content;
  assert.ok(prompt.indexOf('question 1 | answer to: question 1') !== -1, 'existing summary is the base');
  assert.ok(prompt.indexOf('\nquestion 1\n') === -1, 'already-summarized messages are not resent');
  assert.ok(prompt.indexOf('[#3 user') !== -1 && prompt.indexOf('[#4 assistant') !== -1);
  summary = h.readJson(store.summaryFile);
  assert.strictEqual(summary.messagesCovered, 4);
  assert.strictEqual(h.readJson(store.historyFile).messages.length, 14, 'history.json keeps every original');
});

test('a fact from the first message still reaches DeepSeek once it has left the window', async () => {
  const { agent, client } = await h.makeAgent();
  await agent.ask('My project uses Node.js.');
  await turns(agent, 6, 'filler ');
  await agent.ask('What technology does my project use?');

  const sent = client.answerCalls().pop().messages;
  const recentText = sent.slice(1).map((m) => m.content).join('\n');
  assert.ok(recentText.indexOf('My project uses Node.js.') === -1, 'no longer among the last 10');
  assert.ok(sent[0].content.indexOf('My project uses Node.js.') !== -1, 'present via the summary');
});

test('DeepSeek failure: question kept, no fake answer, error carries the stored state', async () => {
  const { agent, client, store } = await h.makeAgent();
  client.failAnswers = 1;
  let error = null;
  try {
    await agent.ask('Will this fail?');
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'rejected');
  assert.strictEqual(error.status, 502);
  assert.strictEqual(error.userMessage.content, 'Will this fail?');
  assert.strictEqual(error.memory.messages.length, 1);
  const history = h.readJson(store.historyFile).messages;
  assert.deepStrictEqual(history.map((m) => m.role), ['user'], 'no assistant message invented');

  // Next turn: the API gets alternating turns; the file is untouched.
  await agent.ask('Try again');
  const sent = client.answerCalls().pop().messages;
  assert.strictEqual(sent.length, 2);
  assert.ok(/Will this fail\?[\s\S]*no answer[\s\S]*Try again$/.test(sent[1].content));
  assert.deepStrictEqual(h.readJson(store.historyFile).messages.map((m) => m.content),
    ['Will this fail?', 'Try again', 'answer to: ' + sent[1].content]);
});

test('summary failure: answer still delivered, nothing forgotten, caught up next turn', async () => {
  const { agent, client, store } = await h.makeAgent();
  await turns(agent, 5);
  client.failSummaries = 1;
  const result = await agent.ask('question 6');
  assert.strictEqual(result.answer, 'answer to: question 6');
  assert.strictEqual(result.warnings.length, 1);
  assert.strictEqual(h.readJson(store.summaryFile).messagesCovered, 0);
  assert.strictEqual(result.memory.pendingSummary, 2);

  // Suppose catch-up fails again: the unsummarized messages go verbatim.
  client.failSummaries = 2;
  await agent.ask('question 7');
  const degraded = client.answerCalls().pop().messages;
  assert.ok(degraded[0].content.indexOf('[Older Messages Not Yet Summarized]') !== -1);
  assert.ok(degraded[0].content.indexOf('user: question 1') !== -1);
  assert.strictEqual(degraded.length, 12, 'still exactly 10 recent turns + question');

  await agent.ask('question 8');
  assert.strictEqual(h.readJson(store.summaryFile).messagesCovered, 6, 'caught up');
  const healthy = client.answerCalls().pop().messages;
  assert.ok(healthy[0].content.indexOf('[Older Messages Not Yet Summarized]') === -1);
});

test('no API key: 503 and nothing stored', async () => {
  const client = new h.FakeClient();
  client.configured = false;
  const { agent, store } = await h.makeAgent({ client: client });
  await assert.rejects(agent.ask('hello'), (err) => err.status === 503);
  assert.strictEqual(h.readJson(store.historyFile).messages.length, 0);
});

test('invalid questions are rejected before anything is stored', async () => {
  const { agent, store } = await h.makeAgent({ maxQuestionChars: 20 });
  await assert.rejects(agent.ask('   '), (err) => err.status === 400);
  await assert.rejects(agent.ask(42), (err) => err.status === 400);
  await assert.rejects(agent.ask('x'.repeat(21)), (err) => err.status === 413);
  assert.strictEqual(h.readJson(store.historyFile).messages.length, 0);
});

test('token statistics: API usage exact, question estimated, history = summary + last 10', async () => {
  const { agent } = await h.makeAgent();
  await turns(agent, 6);
  const r = await agent.ask('What is Kubernetes?');
  const t = r.tokens;
  assert.strictEqual(t.input, 120);
  assert.strictEqual(t.output, 9);
  assert.strictEqual(t.total, 129);
  assert.strictEqual(t.apiEstimated, false);
  assert.strictEqual(t.currentRequest, require('../src/services/tokenService').count('What is Kubernetes?'));
  assert.strictEqual(t.currentRequestEstimated, true);
  assert.strictEqual(r.message.tokens, 9, 'answer tokens = completion tokens');
  assert.strictEqual(r.message.tokensSource, 'api');
  assert.strictEqual(t.summary, 25, 'summary tokens from the summarization usage');
  const recentSum = r.memory.messages.reduce((s, m) => s + m.tokens, 0);
  assert.strictEqual(t.fullHistory, recentSum);
  assert.strictEqual(t.historyTotal, t.summary + t.fullHistory);
  assert.strictEqual(t.fullHistoryEstimated, true, 'questions in the window are estimates');
  assert.deepStrictEqual(r.memory.lastApiCall, { input: 120, output: 9, estimated: false, model: 'fake', total: 129 });
});

test('missing usage falls back to labelled estimates', async () => {
  const client = new h.FakeClient();
  client.noUsage = true;
  const { agent } = await h.makeAgent({ client: client });
  const r = await agent.ask('What is Node.js?');
  assert.strictEqual(r.tokens.apiEstimated, true);
  assert.ok(r.tokens.input > 0 && r.tokens.output > 0);
  assert.strictEqual(r.message.tokensSource, 'estimate');
});

test('simultaneous questions are serialized: each answer follows its question', async () => {
  const { agent, store } = await h.makeAgent();
  await Promise.all([agent.ask('A'), agent.ask('B'), agent.ask('C')]);
  const contents = h.readJson(store.historyFile).messages.map((m) => m.content);
  assert.deepStrictEqual(contents, ['A', 'answer to: A', 'B', 'answer to: B', 'C', 'answer to: C']);
});
