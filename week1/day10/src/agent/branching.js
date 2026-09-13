'use strict';

const crypto = require('crypto');
const AgentError = require('./errors').AgentError;
const schema = require('../storage/schema');

const MAIN = schema.MAIN_BRANCH;

/**
 * Checkpoints and branches.
 *
 * Every message carries a `branchId`. Without a checkpoint all messages are in
 * "main". Creating a checkpoint freezes "main" as the shared base and creates
 * two branches; from then on new messages are written to the active branch
 * only. A branch's conversation — its *path* — is therefore
 *
 *     messages in "main" (the base)  +  messages in that branch
 *
 * in stored order. The inactive branch's messages are never on the path, so
 * they are never shown in the chat or sent to DeepSeek.
 *
 * Deleting the checkpoint removes one branch's messages from state.json and
 * relabels the survivor's messages as "main": the survivor becomes the normal
 * conversation again, unchanged.
 */
class BranchingManager {
  hasCheckpoint(state) {
    return Boolean(branching(state).checkpoint);
  }

  activeBranchId(state) {
    const b = branching(state);
    return b.checkpoint ? b.activeBranchId : MAIN;
  }

  /** The active conversation: base + active branch, oldest first. */
  pathMessages(state) {
    return this.pathFor(state, this.activeBranchId(state));
  }

  pathFor(state, branchId) {
    return state.messages.filter(function (m) { return m.branchId === MAIN || m.branchId === branchId; });
  }

  /**
   * Branching mode sends the whole active path; the context limit in
   * ContextManager trims the oldest messages if it does not fit.
   */
  select(path) {
    return { history: path.slice(), excluded: [] };
  }

  /** @returns {object} The new checkpoint record. */
  createCheckpoint(state, now) {
    const b = branching(state);
    if (b.checkpoint) {
      throw new AgentError('A checkpoint already exists. Delete it before creating a new one.', 409);
    }
    const ts = (now || new Date()).toISOString();
    const base = state.messages.filter(function (m) { return m.branchId === MAIN; });
    const suffix = crypto.randomBytes(4).toString('hex');
    const branchA = { id: 'branch-' + suffix + '-a', name: 'Branch A', parentId: MAIN, createdAt: ts };
    const branchB = { id: 'branch-' + suffix + '-b', name: 'Branch B', parentId: MAIN, createdAt: ts };

    b.checkpoint = {
      id: 'checkpoint-' + suffix,
      createdAt: ts,
      afterMessageId: base.length ? base[base.length - 1].id : null,
      baseMessageCount: base.length,
      branchIds: [branchA.id, branchB.id]
    };
    b.branches = [mainRecord(b), branchA, branchB];
    b.activeBranchId = branchA.id;
    return b.checkpoint;
  }

  /**
   * @param {string} [branchId] Omit to switch to the other branch.
   * @returns {object} The now-active branch record.
   */
  switchBranch(state, branchId) {
    const b = branching(state);
    if (!b.checkpoint) throw new AgentError('There is no checkpoint, so there is no other branch.', 409);
    const target = branchId === undefined || branchId === null || branchId === ''
      ? b.checkpoint.branchIds.filter(function (id) { return id !== b.activeBranchId; })[0]
      : branchId;
    if (b.checkpoint.branchIds.indexOf(target) === -1) throw new AgentError('Unknown branch.', 400);
    b.activeBranchId = target;
    return findBranch(b, target);
  }

  /**
   * Remove one branch and the checkpoint; the other branch becomes "main".
   * @returns {{removedBranchId: string, survivorBranchId: string, removedMessages: number}}
   */
  deleteCheckpoint(state, branchIdToRemove) {
    const b = branching(state);
    if (!b.checkpoint) throw new AgentError('There is no checkpoint to delete.', 409);
    if (typeof branchIdToRemove !== 'string' || !branchIdToRemove) {
      throw new AgentError('Select the branch to remove.', 400);
    }
    if (b.checkpoint.branchIds.indexOf(branchIdToRemove) === -1) throw new AgentError('Unknown branch.', 400);

    const survivor = b.checkpoint.branchIds.filter(function (id) { return id !== branchIdToRemove; })[0];
    const before = state.messages.length;
    state.messages = state.messages.filter(function (m) { return m.branchId !== branchIdToRemove; });
    state.messages.forEach(function (m) { if (m.branchId === survivor) m.branchId = MAIN; });

    b.checkpoint = null;
    b.branches = [mainRecord(b)];
    b.activeBranchId = MAIN;
    return { removedBranchId: branchIdToRemove, survivorBranchId: survivor, removedMessages: before - state.messages.length };
  }

  /** The branch view for the UI. */
  describe(state) {
    const b = branching(state);
    const active = this.activeBranchId(state);
    return {
      checkpoint: b.checkpoint,
      activeBranchId: active,
      branches: b.branches.map((br) => ({
        id: br.id,
        name: br.name,
        isBase: br.id === MAIN,
        active: br.id === active,
        // Messages of this branch alone (for "main": the base before the checkpoint).
        ownMessages: state.messages.filter(function (m) { return m.branchId === br.id; }).length,
        pathMessages: this.pathFor(state, br.id).length
      }))
    };
  }
}

function branching(state) {
  return state.contextManagement.branching;
}

function findBranch(b, id) {
  return b.branches.filter(function (br) { return br.id === id; })[0] || null;
}

function mainRecord(b) {
  return findBranch(b, MAIN) || { id: MAIN, name: 'Main', parentId: null, createdAt: new Date().toISOString() };
}

module.exports = { BranchingManager, MAIN_BRANCH: MAIN };
