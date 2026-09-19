import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { logger, tempDir } from './helpers.js';
import { InvariantChecker, parseRule } from '../src/agent/invariantChecker.js';
import { InvariantManager } from '../src/invariants/invariantManager.js';

const stack = { id: 'stack', name: 'Backend stack', value: 'Node.js + Express', category: 'stack', enabled: true, forbidden: [] };
const db = { id: 'db', name: 'Database', value: 'PostgreSQL only, never MongoDB', category: 'architecture', enabled: true, forbidden: [] };
const secrets = { id: 'secrets', name: 'Secrets', value: 'No hard-coded keys', category: 'security', enabled: true, forbidden: ['hard-coded api key'] };

test('invariants: create, view, update, enable/disable, delete — stored separately', async (t) => {
  const dir = await tempDir(t);
  const manager = new InvariantManager({ dataDir: dir, logger: logger() });
  await manager.init();

  const created = await manager.create({ name: 'Backend stack', value: 'Node.js + Express', category: 'stack' });
  assert.equal(created.id, 'backend-stack');
  assert.equal(created.enabled, true);
  await assert.rejects(manager.create({ id: 'backend-stack', name: 'x', value: 'y' }), (err) => err.status === 409);
  await assert.rejects(manager.create({ name: '', value: 'y' }), (err) => err.status === 400);

  await manager.update('backend-stack', { value: 'Node.js 22 + Express 5' });
  await manager.setEnabled('backend-stack', false);
  const [stored] = await new InvariantManager({ dataDir: dir, logger: logger() }).list();
  assert.equal(stored.value, 'Node.js 22 + Express 5');
  assert.equal(stored.enabled, false);
  assert.deepEqual(await manager.getActive(), []);

  const file = JSON.parse(await readFile(path.join(dir, 'invariants.json'), 'utf8'));
  assert.deepEqual(Object.keys(file), ['invariants']);

  await manager.delete('backend-stack');
  assert.deepEqual(await manager.list(), []);
  await assert.rejects(manager.delete('backend-stack'), (err) => err.status === 404);
  assert.equal((await manager.addExamples()).length, 3);
  assert.equal((await manager.addExamples()).length, 0, 'examples are not added twice');
});

test('rules are read from the invariant text', () => {
  const rule = parseRule(db);
  assert.deepEqual([...rule.allowed.get('database')], ['postgresql']);
  assert.deepEqual([...rule.forbidden], ['mongodb']);
  const s = parseRule(stack);
  assert.deepEqual([...s.allowed.get('language')], ['javascript']);
  assert.deepEqual([...s.allowed.get('framework')], ['express']);
});

test('the checker detects a conflicting action (the specification example)', () => {
  const checker = new InvariantChecker();
  const result = checker.check({ type: 'request', text: 'Rewrite backend in Python' }, [stack]);
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].invariantId, 'stack');
  assert.equal(result.conflicts[0].method, 'rule');
  assert.match(result.conflicts[0].reason, /Python.*requires Node\.js/);
});

test('the checker covers frameworks, databases, forbidden technologies and terms', () => {
  const checker = new InvariantChecker();
  const conflicts = (type, text, invariants = [stack, db, secrets]) => [...new Set(checker.check({ type, text }, invariants).conflicts.map((c) => c.invariantId))];

  assert.deepEqual(conflicts('request', 'Build the API with Django'), ['stack']);
  assert.deepEqual(conflicts('request', 'Use Fastify instead of Express'), ['stack']);
  assert.deepEqual(conflicts('request', 'Store sessions in MongoDB'), ['db']);
  assert.deepEqual(conflicts('request', 'Put a hard-coded API key into app.js'), ['secrets']);
  assert.deepEqual(conflicts('plan', '1. Create the service in Go with Gin'), ['stack']);
  assert.deepEqual(conflicts('response', 'Here:\n```python\nprint(1)\n```'), ['stack']);
});

test('the checker does not flag questions, negations or allowed choices', () => {
  const checker = new InvariantChecker();
  const ok = (type, text) => checker.check({ type, text }, [stack, db, secrets]).ok;

  assert.ok(ok('request', 'What is Python?'));
  assert.ok(ok('request', 'Compare Node.js with Python'));
  assert.ok(ok('request', 'Migrate away from Python to Node.js'));
  assert.ok(ok('request', 'Add a /health route to the Express app and store data in PostgreSQL'));
  assert.ok(ok('plan', '1. Keep Node.js; do not use Python\n2. Never use MongoDB'));
  assert.ok(ok('response', 'Done:\n```js\nconsole.log(1)\n```\nWe kept Node.js instead of Python.'));
});

test('disabled invariants are not enforced', () => {
  const checker = new InvariantChecker();
  assert.ok(checker.check({ type: 'request', text: 'Rewrite backend in Python' }, [{ ...stack, enabled: false }]).ok);
});

test('conflicts reported by the model are validated against the active invariants', () => {
  const checker = new InvariantChecker();
  const reported = [
    { invariantId: 'stack', reason: 'needs Python' },
    { invariantId: 'unknown', reason: 'made up' },
    { invariantId: 'Database', reason: 'matched by name' },
  ];
  const out = checker.fromModel(reported, [stack, { ...db }, { ...secrets, enabled: false }], 'plan');
  assert.deepEqual(out.map((c) => [c.invariantId, c.method]), [['stack', 'model'], ['db', 'model']]);
});
