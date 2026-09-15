import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContext, LONG_TERM_HEADER, WORK_HEADER } from '../src/agent/contextBuilder.js';
import { emptyTask } from '../src/memory/workMemory.js';

const longTerm = {
  profile: { name: 'Max', preferred_language: 'English' },
  preferences: ['Short answers'],
  solutions: [{ problem: 'Port in use', solution: 'Change PORT' }],
  knowledge: [{ topic: 'Node.js', fact: 'Single-threaded event loop' }],
};
const work = { ...emptyTask(), task: 'Build an agent', decisions: ['Use Express'] };
const shortTerm = [
  { id: '1', role: 'user', content: 'What is Node.js?', timestamp: '2026-09-15T10:00:00Z' },
  { id: '2', role: 'assistant', content: 'A JavaScript runtime.', timestamp: '2026-09-15T10:00:05Z' },
];

test('the context is system (with long-term and work memory), then the conversation, then the request', () => {
  const { messages } = buildContext({ systemPrompt: 'You are an agent.', longTerm, work, shortTerm, request: 'And Express?' });

  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);

  const system = messages[0].content;
  assert.ok(system.startsWith('You are an agent.'));
  assert.ok(system.indexOf(LONG_TERM_HEADER) < system.indexOf(WORK_HEADER), 'long-term precedes work memory');
  for (const expected of ['name: Max', 'preferred language: English', 'Short answers', 'Port in use', '[Node.js]', 'Task: Build an agent', 'Use Express']) {
    assert.ok(system.includes(expected), `system message contains "${expected}"`);
  }

  assert.equal(messages[1].content, 'What is Node.js?');
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'And Express?' });
});

test('only role and content of stored messages reach the API', () => {
  const { messages } = buildContext({ shortTerm, request: 'x' });
  for (const message of messages) assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
});

test('empty or disabled layers are left out entirely', () => {
  const { messages, sections } = buildContext({
    systemPrompt: 'Be brief.',
    longTerm: { profile: {}, preferences: [], solutions: [], knowledge: [] },
    work: emptyTask(),
    shortTerm: [],
    request: 'Hello',
  });

  assert.deepEqual(messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }]);
  assert.equal(sections.longTerm, '');
  assert.equal(sections.work, '');
});

test('an empty draft adds no user turn (the memory-only baseline)', () => {
  const { messages } = buildContext({ systemPrompt: 'S', shortTerm, request: '   ' });
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant']);
});
