import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractMemoryUpdates, lastExchange } from '../src/agent/memoryExtractor.js';

test('explicit lines become work memory updates', () => {
  const { work, longTerm } = extractMemoryUpdates({
    userMessage: 'task: Build the agent\n- decision: Use Express.\nTODO: write tests\nstatus: halfway\nWe decided to use JSON files',
  });
  assert.deepEqual(work, [
    { field: 'task', value: 'Build the agent' },
    { field: 'decisions', value: 'Use Express' },
    { field: 'todos', value: 'write tests' },
    { field: 'currentState', value: 'halfway' },
    { field: 'decisions', value: 'use JSON files' },
  ]);
  assert.deepEqual(longTerm, []);
});

test('stable facts become long-term memory updates', () => {
  const { longTerm } = extractMemoryUpdates({
    userMessage: [
      'Hi, my name is Max and I like tea.',
      'I prefer short answers',
      'remember about Node.js: it runs on V8',
      'my time zone is Europe/Riga',
    ].join('\n'),
  });
  assert.deepEqual(longTerm, [
    { category: 'profile', key: 'name', value: 'Max' },
    { category: 'preferences', value: 'short answers' },
    { category: 'knowledge', topic: 'Node.js', fact: 'it runs on V8' },
    { category: 'profile', key: 'timezone', value: 'Europe/Riga' },
  ]);
});

test('"that worked" saves the previous exchange as a solution', () => {
  const previousExchange = { question: 'Port 3000 is taken', answer: 'Set PORT=3001' };
  const { longTerm } = extractMemoryUpdates({ userMessage: 'That worked!', previousExchange });
  assert.deepEqual(longTerm, [{ category: 'solutions', problem: 'Port 3000 is taken', solution: 'Set PORT=3001' }]);

  assert.deepEqual(extractMemoryUpdates({ userMessage: 'That worked!', previousExchange: null }).longTerm, []);
});

test('ordinary questions save nothing', () => {
  for (const userMessage of ['What is Node.js?', 'Can you call me back later?', 'Explain the task queue', '']) {
    assert.deepEqual(extractMemoryUpdates({ userMessage }), { work: [], longTerm: [] }, userMessage);
  }
});

test('lastExchange finds the latest question/answer pair', () => {
  const messages = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ];
  assert.deepEqual(lastExchange(messages), { question: 'q2', answer: 'a2' });
  assert.equal(lastExchange([]), null);
});
