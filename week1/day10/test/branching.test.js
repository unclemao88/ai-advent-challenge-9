'use strict';

const assert = require('assert');
const test = require('./harness').test;
const h = require('./helpers');

async function branchingAgent(baseQuestions) {
  const t = await h.makeAgent();
  await t.agent.updateContext({ mode: 'branching' });
  await h.askMany(t.agent, baseQuestions || ['base 1', 'base 2']);
  return t;
}

function allContent(call) {
  return call.messages.map(function (m) { return m.content; }).join('\n');
}

test('a checkpoint requires Branching mode', async function () {
  const t = await h.makeAgent();
  await assert.rejects(t.agent.createCheckpoint(), function (err) { return err.status === 409 && /Branching/.test(err.message); });
});

test('a checkpoint creates two branches and exactly one is active', async function () {
  const t = await branchingAgent();
  const out = await t.agent.createCheckpoint();
  const b = out.state.contextManagement.branching;

  assert.ok(b.checkpoint);
  assert.strictEqual(b.checkpoint.baseMessageCount, 4);
  assert.strictEqual(b.checkpoint.afterMessageId, out.state.messages[3].id);
  const branches = b.branches.filter(function (br) { return !br.isBase; });
  assert.deepStrictEqual(branches.map(function (br) { return br.name; }), ['Branch A', 'Branch B']);
  assert.strictEqual(b.branches.filter(function (br) { return br.active; }).length, 1);
  assert.strictEqual(b.activeBranchId, branches[0].id);
  assert.strictEqual(out.state.messages.length, 4, 'both branches start with the same conversation');

  const disk = h.readJson(t.file).contextManagement.branching;
  assert.deepStrictEqual(disk.checkpoint.branchIds, [branches[0].id, branches[1].id]);
  assert.strictEqual(disk.activeBranchId, branches[0].id);
});

test('only one checkpoint can exist at a time', async function () {
  const t = await branchingAgent();
  await t.agent.createCheckpoint();
  await assert.rejects(t.agent.createCheckpoint(), function (err) { return err.status === 409 && /already exists/.test(err.message); });
  assert.strictEqual(h.readJson(t.file).contextManagement.branching.branches.length, 3);
});

test('switching branches changes the active context; the inactive branch is never sent to DeepSeek', async function () {
  const t = await branchingAgent();
  const created = await t.agent.createCheckpoint();
  const ids = created.result.branchIds;

  await t.agent.ask('only in A');
  let state = (await t.agent.switchBranch()).state;
  assert.strictEqual(state.contextManagement.branching.activeBranchId, ids[1], 'switch without an id goes to the other branch');
  assert.deepStrictEqual(h.contents(state.messages), ['base 1', 'answer to: base 1', 'base 2', 'answer to: base 2']);

  await t.agent.ask('only in B');
  let call = t.client.answerCalls().pop();
  assert.ok(/base 1/.test(allContent(call)), 'base history is shared');
  assert.ok(!/only in A/.test(allContent(call)), 'branch A is not sent while B is active');
  const bMessages = h.readJson(t.file).messages.filter(function (m) { return m.branchId === ids[1]; });
  assert.deepStrictEqual(h.contents(bMessages), ['only in B', 'answer to: only in B']);

  state = (await t.agent.switchBranch(ids[0])).state;
  const contextText = state.messages.filter(function (m) { return state.context.historyIds.indexOf(m.id) !== -1; })
    .map(function (m) { return m.content; }).join('\n');
  assert.ok(/only in A/.test(contextText) && !/only in B/.test(contextText));

  await t.agent.ask('A again');
  call = t.client.answerCalls().pop();
  assert.ok(/only in A/.test(allContent(call)));
  assert.ok(!/only in B/.test(allContent(call)), 'branch B is not sent while A is active');
  assert.strictEqual(h.readJson(t.file).contextManagement.branching.activeBranchId, ids[0], 'active branch is persisted');

  await assert.rejects(t.agent.switchBranch('nope'), function (err) { return err.status === 400; });
});

test('deleting the checkpoint requires choosing a branch', async function () {
  const t = await branchingAgent();
  await t.agent.createCheckpoint();
  await assert.rejects(t.agent.deleteCheckpoint(), function (err) { return err.status === 400 && /Select the branch/.test(err.message); });
  await assert.rejects(t.agent.deleteCheckpoint('main'), function (err) { return err.status === 400; });
  assert.ok(h.readJson(t.file).contextManagement.branching.checkpoint, 'nothing was deleted');
});

test('deleting one branch removes it and keeps the other as the normal conversation', async function () {
  const t = await branchingAgent();
  const ids = (await t.agent.createCheckpoint()).result.branchIds;
  await t.agent.ask('keep me (A)');
  await t.agent.switchBranch(ids[1]);
  await t.agent.ask('delete me (B)');
  await t.agent.switchBranch(ids[0]);
  const before = h.contents((await t.agent.getState()).messages);

  const out = await t.agent.deleteCheckpoint(ids[1]);
  assert.deepStrictEqual(out.result, { removedBranchId: ids[1], survivorBranchId: ids[0], removedMessages: 2 });

  const b = out.state.contextManagement.branching;
  assert.strictEqual(b.checkpoint, null);
  assert.strictEqual(b.activeBranchId, 'main');
  assert.deepStrictEqual(b.branches.map(function (br) { return br.id; }), ['main']);
  assert.deepStrictEqual(h.contents(out.state.messages), before, 'the surviving branch is unchanged');

  const disk = h.readJson(t.file);
  assert.ok(!disk.messages.some(function (m) { return /delete me/.test(m.content); }), 'the deleted branch is gone from state.json');
  assert.ok(disk.messages.every(function (m) { return m.branchId === 'main'; }));

  await t.agent.ask('after delete');
  assert.ok(/keep me/.test(allContent(t.client.answerCalls().pop())));
  const again = await t.agent.createCheckpoint();
  assert.ok(again.result.id, 'a new checkpoint can be enabled again');
});

test('deleting the active branch makes the other branch active', async function () {
  const t = await branchingAgent();
  const ids = (await t.agent.createCheckpoint()).result.branchIds;
  await t.agent.ask('in A');
  await t.agent.switchBranch(ids[1]);
  await t.agent.ask('in B');
  const out = await t.agent.deleteCheckpoint(ids[1]);
  assert.deepStrictEqual(h.contents(out.state.messages).slice(-2), ['in A', 'answer to: in A']);
});

test('sticky facts are kept per branch', async function () {
  const t = await h.makeAgent();
  await t.agent.updateContext({ mode: 'branching', stickyFacts: { N: 2 } });
  const ids = (await t.agent.createCheckpoint()).result.branchIds;

  await t.agent.updateContext({ mode: 'sticky-facts' });
  await h.askMany(t.agent, ['city=Riga', 'x', 'y']);
  assert.deepStrictEqual(h.factsObject(await t.agent.getState()), { city: 'Riga' });

  await t.agent.updateContext({ mode: 'branching' });
  await t.agent.switchBranch(ids[1]);
  await t.agent.updateContext({ mode: 'sticky-facts' });
  assert.deepStrictEqual(h.factsObject(await t.agent.getState()), {}, 'Branch B does not see facts learned in Branch A');

  await t.agent.updateContext({ mode: 'branching' });
  await t.agent.deleteCheckpoint(ids[1]);
  await t.agent.updateContext({ mode: 'sticky-facts' });
  assert.deepStrictEqual(h.factsObject(await t.agent.getState()), { city: 'Riga' }, 'the survivor keeps its facts');
});

test('switching or deleting without a checkpoint is refused', async function () {
  const t = await branchingAgent();
  await assert.rejects(t.agent.switchBranch(), function (err) { return err.status === 409; });
  await assert.rejects(t.agent.deleteCheckpoint('x'), function (err) { return err.status === 409; });
});
