import { ContextBuilder } from './contextBuilder.js';
import { InvariantChecker } from './invariantChecker.js';
import { Planner } from './planner.js';
import { Executor } from './executor.js';
import { Validator } from './validator.js';
import * as SM from './stateMachine.js';
import { ShortTermMemory } from '../memory/shortTermMemory.js';
import { extractMemoryCommands } from '../memory/memoryCommands.js';
import { emptyWorkMemory } from '../memory/workMemory.js';
import { AppError, badRequest, conflict } from '../utils/errors.js';
import { clip } from '../utils/validate.js';

const PREVIEW_TASK_ID = 'task-00000000-0000-4000-8000-000000000000';
export const CONFLICT_DECISIONS = Object.freeze(['keep', 'disable', 'updated', 'cancel']);
const MAX_PROMOTION_CANDIDATES = 5;

/**
 * The agent: the orchestration layer. It controls the complete lifecycle of a
 * task and enforces every application rule before and after DeepSeek is called.
 *
 *   request → task manager → state machine → profile, invariants, short-term,
 *   work and long-term memory → ContextBuilder → token count → DeepSeek
 *   → response validation (state, invariants, profile) → memory/task updates
 *   → persistence → UI
 *
 * One DeepSeek call per working state (plus corrections of a rejected
 * response). In manual mode every operation runs one state and stops; in auto
 * mode the agent keeps advancing through the legal transitions until the task
 * is done, needs the user (a question or an invariant conflict), is paused,
 * fails, or hits the per-run step limit.
 *
 * Operations (all return the same result shape, see #result):
 *   ask(message)               start a task, or give input to the active one
 *   continueTask(id)           run the next state, or retry a failed one
 *   pauseTask(id) / resumeTask(id)
 *   setMode(id, mode)          manual ↔ auto (auto also carries on from a finished step)
 *   resolveConflict(id, how)   keep | disable | updated | cancel, after an invariant conflict
 *   cancelTask(id), startNewTask(), deleteTask(id)
 *
 * Memory update rules (deterministic, inspectable):
 *   short-term   every user message and agent answer
 *   work         what the step produced (plan, decisions, results, checks) + "requirement:/decision:/fact:" lines
 *   long-term    only on "remember: …" lines, the memory panel, promotions, or a suggestion the user approved
 *                (the completion message offers the task's decisions and results as candidates)
 */
export class Agent {
  /**
   * @param {{
   *   llm: object, memory: import('../memory/memoryManager.js').MemoryManager,
   *   profiles: import('../profile/profileManager.js').ProfileManager,
   *   invariants: import('../invariants/invariantManager.js').InvariantManager,
   *   tasks: import('../tasks/taskManager.js').TaskManager,
   *   history: import('../history/chatHistory.js').ChatHistory,
   *   tokenCounter: import('../token/tokenCounter.js').TokenCounter,
   *   logger: object, options?: object
   * }} deps
   */
  constructor({ llm, memory, profiles, invariants, tasks, history, tokenCounter, logger, options = {} }) {
    this.llm = llm;
    this.memory = memory;
    this.profiles = profiles;
    this.invariants = invariants;
    this.tasks = tasks;
    this.history = history;
    this.tokenCounter = tokenCounter;
    this.logger = logger;
    this.options = {
      maxAutoSteps: options.maxAutoSteps ?? 8,
      maxValidationRetries: options.maxValidationRetries ?? 2,
      maxInvariantRevisions: options.maxInvariantRevisions ?? 1,
      maxProfileRevisions: options.maxProfileRevisions ?? 1,
      longTermContextTokens: options.longTermContextTokens ?? 2000,
      maxContextTokens: options.maxContextTokens ?? 100_000,
    };
    this.contextBuilder = new ContextBuilder({ tokenCounter, maxContextTokens: this.options.maxContextTokens });
    this.checker = new InvariantChecker();

    const deps = {
      llm, checker: this.checker, logger, maxProfileRevisions: this.options.maxProfileRevisions,
      buildContext: (task, state, opts) => this.#buildContext(task, state, opts),
    };
    this.planner = new Planner(deps);
    this.executor = new Executor({ ...deps, maxRevisions: this.options.maxInvariantRevisions });
    this.validator = new Validator(deps);
  }

  // --- Operations -----------------------------------------------------------

  /** @param {{message: string, mode?: 'manual'|'auto', requestId?: string}} input `message` is already validated. */
  async ask({ message, mode, requestId }) {
    let task = await this.tasks.getActiveTask();
    const target = this.#route(task);
    let release;

    if (target.newTask) {
      task = await this.tasks.createTask({ title: titleFrom(message), request: message, mode });
      release = this.tasks.acquire(task.id);
      try {
        await this.memory.createWorkMemory(task.id, { objective: message });
        await this.tasks.setActiveTask(task.id);
      } catch (err) {
        release();
        throw err;
      }
    } else {
      release = this.tasks.acquire(task.id);
    }

    const produced = [];
    try {
      if (!target.newTask && mode && mode !== task.mode) task = await this.tasks.update(task.id, (t) => SM.setMode(t, mode));
      const userMessage = await this.#record({ role: 'user', content: message, taskId: task.id, task: SM.snapshot(task) });
      produced.push(userMessage);
      const memoryUpdates = await this.#applyMemoryCommands(message, task.id);
      this.logger.info('agent.ask', { requestId, taskId: task.id, newTask: target.newTask, state: target.state, chars: message.length });

      // Invariant check of the request itself, before any API call.
      const invariants = await this.invariants.list();
      const pre = this.planner.precheck(message, invariants);
      await this.#recordCheck(task.id, pre, target.state);
      if (!pre.ok) {
        const result = await this.#stopOnRequestConflict(task, target.state, pre, produced, requestId);
        return { ...result, memoryUpdates };
      }

      task = await this.tasks.update(task.id, (t) => SM.beginStep(t, target.state, { reason: 'user message' }));
      const result = await this.#runChain(task, { userMessage, produced, requestId });
      return { ...result, memoryUpdates };
    } catch (err) {
      throw await this.#withResult(err, task.id, produced);
    } finally {
      release();
    }
  }

  async continueTask(taskId, { requestId } = {}) {
    const release = this.tasks.acquire(taskId);
    const produced = [];
    try {
      const task = await this.tasks.update(taskId, (t) => SM.advance(t, { reason: 'continue' }));
      await this.tasks.setActiveTask(taskId);
      return await this.#afterAdvance(task, produced, requestId);
    } catch (err) {
      throw await this.#withResult(err, taskId, produced);
    } finally {
      release();
    }
  }

  async resumeTask(taskId, { requestId } = {}) {
    const release = this.tasks.acquire(taskId);
    const produced = [];
    try {
      let task = await this.tasks.update(taskId, (t) => SM.resume(t));
      await this.tasks.setActiveTask(taskId);
      // Auto mode goes on by itself from the saved state; an open question or conflict still waits.
      if (task.mode === 'auto' && !task.awaitingInput) {
        task = await this.tasks.update(taskId, (t) => SM.advance(t, { reason: 'resumed in auto mode' }));
        return await this.#afterAdvance(task, produced, requestId);
      }
      return this.#result(task, produced);
    } catch (err) {
      throw await this.#withResult(err, taskId, produced);
    } finally {
      release();
    }
  }

  /** Works while a step is running too: the pause then lands when the step ends. */
  async pauseTask(taskId) {
    const task = await this.tasks.update(taskId, (t) => SM.pause(t));
    return this.#result(task, []);
  }

  /**
   * Switch the task (and the default for new tasks) to manual or auto.
   *
   * Manual takes effect at the next transition: a running auto chain stops
   * after its current step. Auto on a task that is waiting for "continue"
   * carries on through the legal transitions right away, since that is what
   * auto mode means. It does not answer questions, decide conflicts or resume
   * a paused task.
   */
  async setMode(taskId, mode, { requestId } = {}) {
    let task = await this.tasks.update(taskId, (t) => SM.setMode(t, mode));
    await this.tasks.setDefaultMode(mode);
    this.logger.info('task.mode', { requestId, taskId, mode });
    const canRun = mode === 'auto' && task.status === SM.STATUSES.ACTIVE && !task.awaitingInput
      && task.stepStatus !== 'running' && !this.tasks.isBusy(taskId);
    if (!canRun) return this.#result(task, []);

    const release = this.tasks.acquire(taskId);
    const produced = [];
    try {
      task = await this.tasks.update(taskId, (t) => SM.advance(t, { reason: 'switched to auto mode' }));
      return await this.#afterAdvance(task, produced, requestId);
    } catch (err) {
      throw await this.#withResult(err, taskId, produced);
    } finally {
      release();
    }
  }

  /**
   * The user's decision after an invariant conflict.
   *   keep     keep the invariant; re-work the task within it
   *   disable  disable the conflicting invariant(s), then go on
   *   updated  the user edited the invariant(s); go on against the new version
   *   cancel   stop the task
   */
  async resolveConflict(taskId, decision, { requestId } = {}) {
    if (!CONFLICT_DECISIONS.includes(decision)) throw badRequest(`decision must be one of: ${CONFLICT_DECISIONS.join(', ')}.`);
    const release = this.tasks.acquire(taskId);
    const produced = [];
    try {
      const current = await this.tasks.requireTask(taskId);
      if (current.awaitingInput?.reason !== 'invariant_conflict' || !current.pendingConflict) {
        throw conflict('This task has no open invariant conflict.', 'no_conflict');
      }
      const ids = [...new Set(current.pendingConflict.conflicts.map((c) => c.invariantId))];
      this.logger.info('invariant.conflict_resolved', { requestId, taskId, decision, invariants: ids });

      if (decision === 'cancel') {
        const task = await this.tasks.update(taskId, (t) => SM.cancel(t, { reason: 'cancelled after an invariant conflict' }));
        await this.#noteResolution(taskId, 'task cancelled');
        produced.push(await this.#record({ role: 'assistant', kind: 'status', content: 'Task cancelled. The invariants were not changed.', taskId, task: SM.snapshot(task) }));
        return this.#result(task, produced);
      }

      let resolution;
      if (decision === 'disable') {
        for (const id of ids) {
          try {
            await this.invariants.setEnabled(id, false);
          } catch (err) {
            if (err.code !== 'invariant_not_found') throw err;
          }
        }
        resolution = `disabled ${ids.map((id) => `"${id}"`).join(', ')}`;
      } else if (decision === 'updated') {
        resolution = `updated ${ids.map((id) => `"${id}"`).join(', ')}`;
      } else {
        resolution = 'the user kept the invariants';
      }
      await this.#noteResolution(taskId, resolution);
      produced.push(await this.#record({
        role: 'assistant', kind: 'status', taskId,
        content: decision === 'keep'
          ? 'Keeping the invariants. Re-working the task within them.'
          : `Invariant ${decision === 'disable' ? 'disabled' : 'updated'} (${ids.join(', ')}). Continuing against the current invariants.`,
      }));

      const task = await this.tasks.update(taskId, (t) => SM.resolveAwaiting(t, {
        reason: `conflict resolved: ${decision}`,
        keepInvariants: decision === 'keep' ? true : t.keepInvariants,
        resolvedConflict: decision === 'keep' ? null : resolution,
      }));
      return await this.#runChain(task, { produced, requestId });
    } catch (err) {
      throw await this.#withResult(err, taskId, produced);
    } finally {
      release();
    }
  }

  async cancelTask(taskId) {
    if (this.tasks.isBusy(taskId)) throw conflict('The agent is still working on this task. Pause it or wait.', 'task_busy');
    const task = await this.tasks.update(taskId, (t) => SM.cancel(t));
    const message = await this.#record({ role: 'assistant', kind: 'status', content: 'Task cancelled.', taskId, task: SM.snapshot(task) });
    return this.#result(task, [message]);
  }

  async activateTask(taskId) {
    const task = await this.tasks.requireTask(taskId);
    await this.tasks.setActiveTask(taskId);
    return this.#result(task, []);
  }

  /** Detach the active task, so the next question starts a new one. */
  async startNewTask() {
    await this.tasks.setActiveTask(null);
    return this.#result(null, []);
  }

  async deleteTask(taskId) {
    await this.tasks.requireTask(taskId);
    await this.tasks.deleteTask(taskId);
    await this.memory.deleteWorkMemory(taskId);
    return { deleted: true, ...(await this.#result(await this.tasks.getActiveTask(), [])) };
  }

  /**
   * The context the next "ask" would send with `draft` as the message, and
   * where that message would go. Nothing is stored and nothing is sent.
   */
  async preview(draft = '') {
    const active = await this.tasks.getActiveTask();
    const target = this.#route(active, { forPreview: true });
    let task = active;
    let work;
    if (target.newTask) {
      const mode = await this.tasks.getDefaultMode();
      task = SM.createTask({ id: PREVIEW_TASK_ID, title: 'preview', request: draft, mode });
      work = { ...emptyWorkMemory(PREVIEW_TASK_ID), objective: clip(draft, 1000) };
    }
    const state = SM.isWorkState(target.state) ? target.state : SM.STATES.PLANNING;
    const context = await this.#buildContext(task, state, { userMessage: draft ? { content: draft } : null, work });
    return {
      context,
      target: { newTask: target.newTask, blocked: target.blocked ?? null, taskId: target.newTask ? null : task.id, state },
    };
  }

  /**
   * Token counts for the UI: each stored layer, the complete next request with
   * `draft` (computed from the ContextBuilder's output, i.e. exactly what would
   * be sent), and the usage DeepSeek reported for the last call.
   */
  async tokenSummary(draft = '') {
    const active = await this.tasks.getActiveTask();
    const [layers, { context, target }] = await Promise.all([
      this.memory.tokenStats(active?.id ?? null),
      this.preview(draft),
    ]);
    const last = active?.lastUsage ?? null;
    return {
      shortTerm: layers.shortTerm,
      work: layers.work,
      longTerm: layers.longTerm,
      longTermBreakdown: layers.longTermBreakdown,
      counts: layers.counts,
      currentContext: context.tokens.total,
      breakdown: context.tokens,
      order: context.order,
      longTermSelected: context.longTermSelected,
      droppedTurns: context.droppedTurns,
      exact: this.tokenCounter.info.exact,
      method: this.tokenCounter.info.method,
      tokenizer: this.tokenCounter.info.name,
      apiInput: last?.promptTokens ?? null,
      apiOutput: last?.completionTokens ?? null,
      total: last?.totalTokens ?? null,
      lastCallContext: last?.contextTokens ?? null,
      target,
    };
  }

  // --- The step runner ------------------------------------------------------

  /** After an advance: finish the task or run the step it entered. */
  async #afterAdvance(task, produced, requestId) {
    if (task.status === SM.STATUSES.DONE) {
      const finished = await this.#finishTask(task, produced);
      return this.#result(finished, produced);
    }
    return this.#runChain(task, { produced, requestId });
  }

  /**
   * Run the step the task is in, then keep going while auto mode allows.
   * `produced` collects every message added, so a failure can still report them.
   */
  async #runChain(task, { userMessage = null, produced, requestId }) {
    const taskId = task.id;
    let current = task;
    let input = userMessage;
    let steps = 0;
    let lastUsage = null;

    for (;;) {
      const step = await this.#runStep(current, input, requestId);
      produced.push(...step.messages);
      lastUsage = step.usage;
      current = step.task;
      input = null;
      steps += 1;

      if (!step.autoContinue) break;
      if (steps >= this.options.maxAutoSteps) {
        current = await this.tasks.update(taskId, (t) => ({
          ...t, plannedAction: `Auto mode stopped after ${steps} steps in one run. Continue to go on (next: ${t.nextState}).`,
        }));
        break;
      }
      // Re-read the task: the user may have paused it or switched to manual meanwhile.
      current = await this.tasks.update(taskId, (t) => (
        t.status === SM.STATUSES.ACTIVE && t.stepStatus === 'completed' && t.mode === 'auto' && !t.awaitingInput
          ? SM.advance(t, { reason: 'auto mode' }) : t
      ));
      if (current.status === SM.STATUSES.DONE) {
        current = await this.#finishTask(current, produced);
        break;
      }
      if (current.stepStatus !== 'running') break;
    }
    return this.#result(current, produced, lastUsage);
  }

  async #runStep(task, userMessage, requestId) {
    const state = task.state;
    const invariants = await this.invariants.list();
    const lastMove = task.history.at(-1);
    const notes = {
      keepInvariants: Boolean(task.keepInvariants),
      resolvedConflict: task.resolvedConflict ?? null,
      rerun: Boolean(lastMove && lastMove.from === state && lastMove.to === state),
    };
    const input = { task, invariants, userMessage, notes, requestId };

    let outcome;
    if (state === SM.STATES.PLANNING) outcome = await this.planner.run(input);
    else if (state === SM.STATES.EXECUTION) outcome = await this.executor.run(input);
    else if (state === SM.STATES.VALIDATION) outcome = await this.validator.run({ ...input, lastResult: await this.#lastResult(task) });
    else throw new SM.InvalidTransitionError(state, state, 'nothing to run in this state');

    const messages = [];
    const { reply, usage, profileCheck } = outcome;

    // Work memory first: the record of what this step produced and what was checked.
    const checks = [...(outcome.rejected ?? []).map((r) => r.check), outcome.check].map((c) => ({
      stage: c.stage, ok: c.ok, conflicts: c.conflicts.map(({ invariantId, name, method, reason }) => ({ invariantId, name, method, reason })),
    }));
    await this.memory.updateWorkMemory(task.id, {
      ...outcome.workUpdates,
      invariantChecks: checks,
      profileChecks: [{ stage: state, ok: profileCheck.ok, revisions: profileCheck.revisions, issues: profileCheck.issues.map((i) => i.message) }],
      proposals: reply.memoryProposals,
    }, { state, source: 'agent' });
    if (outcome.conflict) {
      this.logger.warn('invariant.conflict', {
        requestId, taskId: task.id, state, stage: outcome.conflict.stage,
        invariants: outcome.conflict.conflicts.map((c) => c.invariantId), methods: outcome.conflict.conflicts.map((c) => c.method),
      });
    }

    for (const rejected of outcome.rejected ?? []) {
      messages.push(await this.#record({
        role: 'assistant', kind: 'status', taskId: task.id,
        content: `A draft result was rejected by the invariant check and is being revised:\n${rejected.check.conflicts.map((c) => `- "${c.name}": ${c.reason}`).join('\n')}`,
        conflicts: rejected.check.conflicts,
      }));
    }

    let autoContinue = false;
    let announce = null;
    let rejectedTransition = null;
    const updated = await this.tasks.update(task.id, (t) => {
      const out = SM.completeStep(t, {
        proposedNext: reply.proposedNext,
        plannedAction: reply.plannedAction,
        needsUserInput: reply.needsUserInput,
        conflict: outcome.conflict,
        verdict: state === SM.STATES.VALIDATION ? reply.validation : null,
        maxValidationRetries: this.options.maxValidationRetries,
      });
      autoContinue = out.autoContinue;
      announce = out.announce;
      rejectedTransition = out.rejected;
      const next = {
        ...out.task, lastUsage: usage, revisions: (t.revisions ?? 0) + (outcome.rejected?.length ?? 0) + profileCheck.revisions,
      };
      if (!outcome.conflict) next.resolvedConflict = null;
      return next;
    });
    if (rejectedTransition) {
      this.logger.warn('state.proposal_rejected', { requestId, taskId: task.id, ...rejectedTransition, next: announce.nextState });
    }

    const conflicts = outcome.conflict?.conflicts ?? [];
    const content = conflicts.length ? conflictMessage(conflicts, reply.response) : reply.response;
    const message = await this.#record({
      role: 'assistant',
      kind: conflicts.length ? 'conflict' : 'message',
      content,
      taskId: task.id,
      task: { ...SM.snapshot(updated, announce), performedState: state },
      validation: reply.validation,
      conflicts,
      rejectedTransition,
      profileCheck: profileCheck.revisions || !profileCheck.ok ? profileCheck : undefined,
      proposals: await this.#newProposals(reply.memoryProposals),
      usage,
    });
    messages.push(message);

    let final = updated;
    if (state === SM.STATES.EXECUTION && !conflicts.length) {
      final = await this.tasks.update(task.id, (t) => ({ ...t, lastResultMessageId: message.id }));
    }
    return { task: final, messages, autoContinue, usage };
  }

  /** The request itself conflicts: keep the task in its current state and ask, before calling DeepSeek. */
  async #stopOnRequestConflict(task, state, check, produced, requestId) {
    this.logger.warn('invariant.conflict', {
      requestId, taskId: task.id, state, stage: 'request', invariants: check.conflicts.map((c) => c.invariantId), methods: ['rule'],
    });
    let announce;
    const updated = await this.tasks.update(task.id, (t) => {
      const out = SM.waitForDecision(t, { conflict: { stage: 'request', conflicts: check.conflicts, resumeIn: state } });
      announce = out.announce;
      return out.task;
    });
    produced.push(await this.#record({
      role: 'assistant',
      kind: 'conflict',
      content: conflictMessage(check.conflicts, null),
      taskId: task.id,
      task: { ...SM.snapshot(updated, announce), performedState: null },
      conflicts: check.conflicts,
    }));
    return this.#result(updated, produced);
  }

  /** The task reached done: record the outcome and offer what could be kept in long-term memory. */
  async #finishTask(task, produced) {
    const work = await this.memory.getWorkMemory(task.id);
    const verdict = work.validationResults.filter((r) => r.passed === true).at(-1);
    const summary = verdict?.text || work.intermediateResults.at(-1)?.text || 'Task complete.';
    const candidates = await this.#promotionCandidates(task, work);
    const finished = await this.tasks.update(task.id, (t) => ({
      ...t, completion: { ...(t.completion ?? {}), summary: clip(summary, 1000), promotionCandidates: candidates.length },
    }));
    produced.push(await this.#record({
      role: 'assistant', kind: 'status', taskId: task.id, task: SM.snapshot(finished),
      content: candidates.length
        ? `Task complete. ${summary}\n\nNothing is kept in long-term memory automatically. Save the items below that are worth keeping.`
        : `Task complete. ${summary}`,
      proposals: candidates,
    }));
    this.logger.info('task.completed', { taskId: task.id, promotionCandidates: candidates.length });
    return finished;
  }

  /**
   * Controlled promotion: when a task is done, its durable parts are offered
   * (never saved) for long-term memory: the model's own suggestions, the
   * decisions (reusable solutions) and the facts (knowledge). The user saves
   * each one explicitly; the rest of the work memory stays with the task.
   */
  async #promotionCandidates(task, work) {
    const all = await this.memory.getLongTermMemory();
    const known = new Set([...all.solutions, ...all.knowledge].map((e) => e.content.trim().toLowerCase()));
    const out = [];
    const add = (category, content, origin) => {
      const text = clip(content, 500);
      const key = text.toLowerCase();
      if (!text || known.has(key) || out.length >= MAX_PROMOTION_CANDIDATES) return;
      known.add(key);
      out.push({ category, content: text, origin });
    };
    for (const p of work.proposals ?? []) add(p.category, p.content, 'agent suggestion');
    for (const d of work.decisions.slice(-3)) add('solutions', d, 'task decision');
    for (const f of work.facts.slice(-2)) add('knowledge', f, 'task fact');
    return out.map((c) => ({ ...c, taskId: task.id }));
  }

  async #buildContext(task, state, { userMessage = null, notes = {}, work } = {}) {
    const [profile, invariants, messages, workMemory] = await Promise.all([
      this.profiles.getProfile(),
      this.invariants.list(),
      this.memory.getShortTermMemory(),
      work ? Promise.resolve(work) : this.memory.getWorkMemory(task.id),
    ]);
    const text = userMessage?.content ?? '';
    const query = [text, workMemory.objective, ...(workMemory.plan ?? [])].filter(Boolean).join('\n');
    const { memory: longTerm, selected } = await this.memory.retrieveLongTerm(query, this.options.longTermContextTokens);
    const turns = ShortTermMemory.toTurns(messages, { excludeId: userMessage?.id });
    const context = this.contextBuilder.build({
      profile, invariants, task, state, work: workMemory, longTerm, shortTerm: turns, userMessage: text || null, notes,
    });
    return { ...context, profile, longTermSelected: selected };
  }

  // --- Helpers --------------------------------------------------------------

  /** Where a new message goes. */
  #route(task, { forPreview = false } = {}) {
    if (!task || SM.isFinal(task)) return { newTask: true, state: SM.STATES.PLANNING };
    if (task.status === SM.STATUSES.PAUSED) {
      if (forPreview) return { newTask: false, state: task.resumeState, blocked: 'paused' };
      throw conflict('The current task is paused. Resume it, or start a new task.', 'task_paused');
    }
    if (task.stepStatus === 'running' || this.tasks.isBusy(task.id)) {
      if (forPreview) return { newTask: false, state: task.state, blocked: 'running' };
      throw conflict('The agent is still working on this task. Wait for it to finish.', 'task_busy');
    }
    return { newTask: false, state: SM.stateForUserMessage(task) ?? SM.STATES.PLANNING };
  }

  /**
   * Save a message: always to the chat history; to short-term memory too
   * unless it is a status or error note (those are not replayed to the model).
   */
  async #record({ role, content, kind = 'message', taskId = null, task = null, ...extra }) {
    const message = await this.history.add({ role, content, kind, taskId, task, ...extra });
    if (kind === 'message' || kind === 'conflict') {
      await this.memory.addMessage({
        id: message.id, timestamp: message.timestamp, role, content, kind, taskId, state: task?.performedState ?? task?.state ?? null,
      });
    }
    return message;
  }

  async #recordCheck(taskId, check, state) {
    await this.memory.updateWorkMemory(taskId, {
      invariantChecks: [{
        stage: check.stage, ok: check.ok,
        conflicts: check.conflicts.map(({ invariantId, name, method, reason }) => ({ invariantId, name, method, reason })),
      }],
    }, { state, source: 'invariant-checker' });
  }

  async #noteResolution(taskId, resolution) {
    await this.memory.updateWorkMemory(taskId, {
      decisions: [`Invariant conflict resolved: ${resolution}.`],
      invariantChecks: [{ stage: 'resolution', ok: true, conflicts: [], resolution }],
    }, { source: 'user' });
  }

  async #applyMemoryCommands(message, taskId) {
    const { longTerm, work } = extractMemoryCommands(message);
    const updates = [];
    for (const item of longTerm) {
      const { entry, created } = await this.memory.addMemory('longTerm', { ...item, source: 'command' });
      updates.push({ layer: 'longTerm', category: entry.category, content: entry.content, id: entry.id, created });
    }
    if (Object.keys(work).length) {
      await this.memory.updateWorkMemory(taskId, work, { source: 'command' });
      for (const [field, items] of Object.entries(work)) {
        for (const content of items) updates.push({ layer: 'work', field, content });
      }
    }
    return updates;
  }

  /** Drop suggestions that long-term memory already holds. */
  async #newProposals(proposals) {
    if (!proposals?.length) return [];
    const all = await this.memory.getLongTermMemory();
    const known = new Set([...all.solutions, ...all.knowledge].map((item) => item.content.trim().toLowerCase()));
    return proposals.filter((p) => !known.has(p.content.trim().toLowerCase()));
  }

  async #lastResult(task) {
    if (!task.lastResultMessageId) return null;
    const messages = await this.history.list();
    return messages.find((m) => m.id === task.lastResultMessageId)?.content ?? null;
  }

  async #result(task, messages, usage = null) {
    const tokens = await this.tokenSummary();
    const lastAnswer = messages.filter((m) => m.role === 'assistant').at(-1);
    return {
      task: SM.publicTask(task),
      response: lastAnswer?.content ?? null,
      messages,
      tokens,
      usage,
    };
  }

  /**
   * After a failure: a task whose step was running goes to `failed` (continue
   * retries it); the error is noted in the chat history; whatever was produced
   * before the failure is attached to the error so the UI can still show it.
   * Nothing already stored is rolled back or lost.
   */
  async #withResult(err, taskId, produced) {
    const safe = (err instanceof AppError || (typeof err?.code === 'string' && err.status)) ? err.message : 'Internal error.';
    try {
      const before = await this.tasks.getTask(taskId);
      if (before?.stepStatus === 'running') {
        const task = await this.tasks.update(taskId, (t) => (t.stepStatus === 'running' ? SM.fail(t, safe) : t));
        produced.push(await this.#record({
          role: 'assistant', kind: 'error', taskId, task: SM.snapshot(task),
          content: `The ${before.state} step failed: ${safe}`,
        }));
      }
      err.result = await this.#result(await this.tasks.getTask(taskId), produced);
    } catch (inner) {
      this.logger.error('agent.result_after_failure', { taskId, error: inner });
    }
    return err;
  }
}

/** The chat text for an invariant conflict. The model's own explanation is kept when it found the conflict itself. */
function conflictMessage(conflicts, modelResponse) {
  const byInvariant = new Map();
  for (const c of conflicts) {
    if (!byInvariant.has(c.invariantId)) byInvariant.set(c.invariantId, { ...c, reasons: [] });
    byInvariant.get(c.invariantId).reasons.push(c.reason);
  }
  const lines = [];
  for (const c of byInvariant.values()) {
    lines.push(`**Conflict detected with invariant "${c.name}"** — \`${c.value}\``);
    for (const reason of [...new Set(c.reasons)]) lines.push(`- ${reason}`);
    lines.push('');
  }
  const modelFound = conflicts.some((c) => c.method === 'model');
  if (modelFound && modelResponse?.trim()) lines.push(modelResponse.trim(), '');
  lines.push('The invariant was **not** violated and nothing was changed. The task stays in its current state. Should the invariant itself be changed?');
  lines.push('Choose **Update invariant**, **Disable invariant**, **Keep invariant** (re-work the task within it) or **Cancel task**.');
  return lines.join('\n');
}

function titleFrom(message) {
  const firstLine = String(message).split('\n').find((line) => line.trim()) ?? 'Task';
  return clip(firstLine, 80);
}
