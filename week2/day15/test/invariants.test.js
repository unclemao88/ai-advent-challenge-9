import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { logger, tempDir } from './helpers.js';
import { InvariantChecker, parseProhibitions, parseRule } from '../src/agent/invariantChecker.js';
import { EXAMPLE_INVARIANTS, InvariantManager, formatInvariants } from '../src/invariants/invariantManager.js';

const inv = (fields) => ({ enabled: true, forbidden: [], ...fields });
const architecture = inv({ id: 'architecture', name: 'Selected architecture', value: 'Modular monolith: one Node.js service split into modules. No microservices.', category: 'architecture' });
const database = inv({ id: 'database', name: 'Database', value: 'PostgreSQL is the adopted database.', category: 'technicalSolutions' });
const api = inv({ id: 'api', name: 'API style', value: 'REST API with JSON', category: 'technicalSolutions' });
const stack = inv({ id: 'stack', name: 'Backend stack', value: 'Backend must use Node.js + Express.', category: 'stackLimitations' });
const cards = inv({ id: 'card-data', name: 'Card data', value: 'Never store full credit card numbers.', category: 'businessRules' });
const secrets = inv({ id: 'secrets', name: 'Secrets', value: 'Keys come from the environment', category: 'businessRules', forbidden: ['hard-coded api key'] });
const ALL = [architecture, database, api, stack, cards, secrets];

const checker = new InvariantChecker();
const conflictIds = (type, text, invariants = ALL) => [...new Set(checker.check({ type, text }, invariants).conflicts.map((c) => c.invariantId))];

test('invariants: add, view, edit, enable/disable, delete, stored separately and grouped by category', async (t) => {
  const dir = await tempDir(t);
  const manager = new InvariantManager({ dataDir: dir, logger: logger() });
  await manager.init();

  const created = await manager.create({ name: 'Backend stack', value: 'Node.js + Express', category: 'stackLimitations' });
  assert.equal(created.id, 'backend-stack');
  assert.equal(created.enabled, true);
  await assert.rejects(manager.create({ id: 'backend-stack', name: 'x', value: 'y' }), (err) => err.status === 409);
  await assert.rejects(manager.create({ name: '', value: 'y' }), (err) => err.status === 400);
  await assert.rejects(manager.create({ name: 'x', value: 'y', category: 'stack' }), (err) => err.status === 400);

  await manager.update('backend-stack', { value: 'Node.js 22 + Express 5' });
  await manager.setEnabled('backend-stack', false);
  const [stored] = await new InvariantManager({ dataDir: dir, logger: logger() }).list();
  assert.equal(stored.value, 'Node.js 22 + Express 5');
  assert.equal(stored.enabled, false);
  assert.deepEqual(await manager.getActive(), []);

  await manager.create({ id: 'db', name: 'Database', value: 'PostgreSQL', category: 'technicalSolutions' });
  const file = JSON.parse(await readFile(path.join(dir, 'invariants', 'invariants.json'), 'utf8'));
  assert.deepEqual(Object.keys(file), ['architecture', 'technicalSolutions', 'stackLimitations', 'businessRules']);
  assert.equal(file.stackLimitations[0].id, 'backend-stack');
  assert.equal(file.technicalSolutions[0].id, 'db');
  assert.ok(!('category' in file.technicalSolutions[0]), 'the category is the group');

  await manager.delete('backend-stack');
  await manager.delete('db');
  assert.deepEqual(await manager.list(), []);
  await assert.rejects(manager.delete('backend-stack'), (err) => err.status === 404);
  assert.equal((await manager.addExamples()).length, EXAMPLE_INVARIANTS.length);
  assert.equal((await manager.addExamples()).length, 0, 'examples are not added twice');
  assert.deepEqual(new Set((await manager.list()).map((i) => i.category)).size, 4, 'one example per category');
});

test('the invariants section groups the active rules by category', () => {
  const text = formatInvariants([...ALL, inv({ id: 'off', name: 'Off', value: 'COBOL', category: 'stackLimitations', enabled: false })]);
  assert.match(text, /^Architecture:\n- \[architecture\]/);
  assert.match(text, /Adopted technical solution:\n- \[database\] Database: PostgreSQL/);
  assert.match(text, /Stack limitation:\n- \[stack\]/);
  assert.match(text, /Business rule:\n- \[card-data\]/);
  assert.ok(!text.includes('COBOL'));
});

test('rules are read from the invariant text', () => {
  const db = parseRule(inv({ value: 'PostgreSQL only, never MongoDB' }));
  assert.deepEqual([...db.allowed.get('database')], ['postgresql']);
  assert.deepEqual([...db.forbidden], ['mongodb']);
  const s = parseRule(stack);
  assert.deepEqual([...s.allowed.get('language')], ['javascript']);
  assert.deepEqual([...s.allowed.get('framework')], ['express']);
  const a = parseRule(architecture);
  assert.deepEqual([...a.allowed.get('architecture')], ['monolith']);
  assert.ok(a.forbidden.has('microservices'));
  assert.deepEqual(parseProhibitions(cards.value), [{ phrase: 'store full credit card numbers', stems: ['stor', 'full', 'cred', 'card', 'numb'] }]);
});

test('a valid response passes every invariant', () => {
  const response = 'Add an Express route in the orders module, store the order in PostgreSQL and expose it as a REST API. '
    + 'We never store full credit card numbers; the payment provider returns a token.\n```js\napp.get("/orders", handler);\n```';
  assert.deepEqual(conflictIds('response', response), []);
});

test('a response violating the architecture invariant is detected', () => {
  assert.deepEqual(conflictIds('response', 'Split the application into microservices, one per module.'), ['architecture']);
  assert.deepEqual(conflictIds('plan', '1. Move the reports module to serverless functions'), ['architecture']);
});

test('a response replacing an adopted technical solution is detected', () => {
  assert.deepEqual(conflictIds('response', 'Migrate the data to MongoDB for flexibility.'), ['database']);
  assert.deepEqual(conflictIds('response', 'Move the data from PostgreSQL to MongoDB.'), ['database'], 'silently replacing PostgreSQL');
  assert.deepEqual(conflictIds('response', 'Replace the REST endpoints with a GraphQL API.'), ['api']);
});

test('a response violating a stack limitation is detected (the specification example)', () => {
  const result = checker.check({ type: 'request', text: 'Rewrite backend in Python' }, [stack]);
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].invariantId, 'stack');
  assert.equal(result.conflicts[0].method, 'rule');
  assert.match(result.conflicts[0].reason, /Python.*requires Node\.js/);
  assert.deepEqual(conflictIds('response', 'Here:\n```python\nprint(1)\n```', [stack]), ['stack']);
  assert.deepEqual(conflictIds('request', 'Build the API with Django', [stack]), ['stack']);
  assert.deepEqual(conflictIds('request', 'Use Fastify instead of Express', [stack]), ['stack']);
  assert.deepEqual(conflictIds('plan', '1. Create the service in Go with Gin', [stack]), ['stack']);
});

test('a response contradicting a business rule is detected', () => {
  assert.deepEqual(conflictIds('response', 'We store the full credit card number in the orders table for refunds.'), ['card-data']);
  assert.deepEqual(conflictIds('response', 'Save the credit card number with the order.'), ['card-data']);
  assert.deepEqual(conflictIds('request', 'Put a hard-coded API key into app.js'), ['secrets']);
  const [conflict] = checker.check({ type: 'response', text: 'We store the full credit card number.' }, [cards]).conflicts;
  assert.match(conflict.reason, /which the business rule forbids/);
  assert.match(conflict.evidence, /store the full credit card number/);
});

test('the checker does not flag questions, negations or compliant choices', () => {
  const ok = (type, text) => checker.check({ type, text }, ALL).ok;
  assert.ok(ok('request', 'What is Python?'));
  assert.ok(ok('request', 'Compare Node.js with Python'));
  assert.ok(ok('request', 'What is the difference between REST and GraphQL?'));
  assert.ok(ok('request', 'Migrate away from Python to Node.js'));
  assert.ok(ok('plan', '1. Keep Node.js; do not use Python\n2. Never use MongoDB'));
  assert.ok(ok('response', 'We keep the modular monolith and do not split it into microservices.'));
  assert.ok(ok('response', 'The rest of the module stays as it is.'));
  assert.ok(ok('response', 'Card numbers are never stored; only a token is kept.'));
});

test('disabled invariants are not enforced', () => {
  assert.ok(checker.check({ type: 'request', text: 'Rewrite backend in Python' }, [{ ...stack, enabled: false }]).ok);
});

test('conflicts reported by the model are validated against the active invariants', () => {
  const reported = [
    { invariantId: 'stack', reason: 'needs Python' },
    { invariantId: 'unknown', reason: 'made up' },
    { invariantId: 'Database', reason: 'matched by name' },
  ];
  const out = checker.fromModel(reported, [stack, database, { ...secrets, enabled: false }], 'plan');
  assert.deepEqual(out.map((c) => [c.invariantId, c.method]), [['stack', 'model'], ['database', 'model']]);
});
