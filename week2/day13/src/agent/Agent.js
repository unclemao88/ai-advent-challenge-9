import { ContextBuilder } from './ContextBuilder.js';
import { parseAgentReply } from './responseParser.js';
import { ShortTermMemory } from '../memory/ShortTermMemory.js';
import { extractMemoryCommands } from '../memory/memoryCommands.js';
import { emptyWorkMemory } from '../memory/WorkMemory.js';
import * as SM from '../state-machine/StateMachine.js';
import { AppError, conflict } from '../utils/errors.js';
import { clip } from '../utils/validate.js';

const PREVIEW_TASK_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The agent: runs tasks through the state machine, one DeepSeek call per state.
 *
 * Operations (all return the same result shape, see #result):
 *   chat(message)      start a task, or give input to the active one
 *   continueTask(id)   run the next state (manual mode), or retry a failed one
 *   resumeTask(id)     leave pause; in auto mode the task runs on
 *   pauseTask(id)      pause now, or after the running step
 *   setMode(id, mode)  manual ↔ auto
 *
 * In manual mode every call runs one state and stops. In auto mode the agent
 * keeps advancing until the task is done, needs the user, is paused, fails, or
 * hits the per-call step limit.
 *
 * The agent never writes to long-term memory on its own. It applies the user's
 * explicit memory commands and returns the model's suggestions for approval.
 */
export class Agent {
  /**
   * @param {{
   *   llm: {complete: Function, configured: boolean, model: string, provider: string},
   *   memory: import('../memory/MemoryManager.js').MemoryManager,
   *   profiles: import('../profile/ProfileManager.js').ProfileManager,
   *   tasks: import('../tasks/TaskManager.js').TaskManager,
   *   tokenCounter: import('../tokens/TokenCounter.js').TokenCounter,
   *   logger: object,
   *   options?: {maxAutoSteps?: number, maxValidationRetries?: number, longTermContextTokens?: number, maxContextTokens?: number}
   * }} deps
   */
  constructor({ llm, memory, profiles, tasks, tokenCounter, logger, options = {} }) {
    this.llm = llm;
    this.memory = memory;
    this.profiles = profiles;
    this.tasks = tasks;
    this.tokenCounter = tokenCounter;
    this.logger = logger;
    this.options = {
      maxAutoSteps: options.maxAutoSteps ?? 8,
      maxValidationRetries: options.maxValidationRetries ?? 2,
      longTermContextTokens: options.longTermContextTokens ?? 4000,
    };
    this.contextBuilder = new ContextBuilder({ tokenCounter, maxContextTokens: options.maxContextTokens ?? 100_000 });
  }

  // --- Operations -----------------------------------------------------------

  /**
   * @param {{message: string, mode?: 'manual'|'auto'}} input `message` is already validated.
   */
  async chat({ message, mode }) {
    let task = await this.tasks.getActiveTask();
    const target = this.#routeMessage(task);
    let release;

    if (target.newTask) {
      task = await this.tasks.createTask({ title: titleFrom(message), mode });
      release = this.tasks.acquire(task.taskId);
      try {
        await this.memory.createWorkMemory(task.taskId, { objective: message });
        await this.tasks.setActiveTask(task.taskId);
      } catch (err) {
        release();
        throw err;
      }
    } else {
      release = this.tasks.acquire(task.taskId);
    }

    const produced = [];
    try {
      const userMessage = await this.memory.addMessage({ role: 'user', content: message, taskId: task.taskId });
      produced.push(userMessage);
      const memoryUpdates = await this.#applyMemoryCommands(message, task.taskId);

      if (!target.newTask) {
        task = await this.tasks.update(task.taskId, (t) => {
          const withMode = mode && mode !== t.mode ? SM.setMode(t, mode) : t;
          return SM.beginStep(withMode, target.state, { reason: 'user message' });
        });
      }
      this.logger.info('agent.chat', { taskId: task.taskId, newTask: target.newTask, state: task.currentState, chars: message.length });

      const result = await this.#runChain(task, { userMessage, produced });
      return { ...result, memoryUpdates };
    } catch (err) {
      throw await this.#withResult(err, task.taskId, produced);
    } finally {
      release();
    }
  }

  async continueTask(taskId) {
    const release = this.tasks.acquire(taskId);
    const produced = [];
    try {
      const task = await this.tasks.update(taskId, (t) => SM.advance(t, { reason: 'continue' }));
      await this.tasks.setActiveTask(taskId);
      if (task.status === SM.STATUSES.COMPLETED) {
        produced.push(await this.#completionMessage(task));
        return this.#result(task, produced);
      }
      return await this.#runChain(task, { produced });
    } catch (err) {
      throw await this.#withResult(err, taskId, produced);
    } finally {
      release();
    }
  }

  async resumeTask(taskId) {
    const release = this.tasks.acquire(taskId);
    const produced = [];
    try {
      let task = await this.tasks.update(taskId, (t) => SM.resume(t));
      await this.tasks.setActiveTask(taskId);
      if (task.mode === 'auto') {
        task = await this.tasks.update(taskId, (t) => SM.advance(t, { reason: 'resumed in auto mode' }));
        if (task.status === SM.STATUSES.COMPLETED) {
          produced.push(await this.#completionMessage(task));
          return this.#result(task, produced);
        }
        return await this.#runChain(task, { produced });
      }
      return this.#result(task, produced);
    } catch (err) {
      throw await this.#withResult(err, taskId, produced);
    } finally {
      release();
    }
  }

  /** Works while a step is running: the pause then lands when the step ends. */
  async pauseTask(taskId) {
    const task = await this.tasks.update(taskId, (t) => SM.pause(t));
    return this.#result(task, []);
  }

  /** Changes the mode of the task and the default for new tasks. Does not run anything. */
  async setMode(taskId, mode) {
    const task = await this.tasks.update(taskId, (t) => SM.setMode(t, mode));
    await this.tasks.setDefaultMode(mode);
    return this.#result(task, []);
  }

  async activateTask(taskId) {
    const task = await this.tasks.requireTask(taskId);
    await this.tasks.setActiveTask(taskId);
    return this.#result(task, []);
  }

  /** Detach the active task, so the next message starts a new one. */
  async startNewSession() {
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
    const target = this.#routeMessage(active, { forPreview: true });
    let task = active;
    let work;
    if (target.newTask) {
      const defaultMode = await this.tasks.getDefaultMode();
      task = SM.createTask({ taskId: PREVIEW_TASK_ID, title: titleFrom(draft || 'new task'), mode: defaultMode });
      work = { ...emptyWorkMemory(PREVIEW_TASK_ID), objective: clip(draft, 1000) };
    } else {
      work = await this.memory.getWorkMemory(task.taskId);
    }
    const context = await this.#buildContext(task, { state: target.state, userMessageText: draft, work });
    return {
      context,
      target: {
        newTask: target.newTask,
        blocked: target.blocked ?? null,
        taskId: target.newTask ? null : task.taskId,
        state: target.state,
      },
    };
  }

  /** Token counts for the UI: stored layers plus the next request with `draft`. */
  async tokenSummary(draft = '') {
    const active = await this.tasks.getActiveTask();
    const [layers, { context, target }] = await Promise.all([
      this.memory.tokenStats(active?.taskId ?? null),
      this.preview(draft),
    ]);
    return {
      ...layers,
      currentRequestContext: context.tokens.total,
      breakdown: context.tokens,
      exact: this.tokenCounter.info.exact,
      method: this.tokenCounter.info.method,
      target,
    };
  }

  // --- The step runner ------------------------------------------------------

  /**
   * Run the step the task is in, then keep going while auto mode allows.
   * `produced` collects every message added, so a failure can still report them.
   */
  async #runChain(task, { userMessage = null, produced }) {
    const taskId = task.taskId;
    let current = task;
    let input = userMessage;
    let steps = 0;
    let lastUsage = null;

    for (;;) {
      const step = await this.#runStep(current, input);
      produced.push(step.message);
      lastUsage = step.usage;
      current = step.task;
      input = null;
      steps += 1;

      if (!step.autoContinue) break;
      if (steps >= this.options.maxAutoSteps) {
        current = await this.tasks.update(taskId, (t) => ({
          ...t, plannedAction: `Auto mode stopped after ${steps} steps in one run. Continue to go on. (Next: ${t.nextState})`,
        }));
        break;
      }
      current = await this.tasks.update(taskId, (t) => (
        t.status === SM.STATUSES.WAITING ? SM.advance(t, { reason: 'auto mode' }) : t
      ));
      if (current.status === SM.STATUSES.COMPLETED) {
        produced.push(await this.#completionMessage(current));
        break;
      }
      if (current.status !== SM.STATUSES.RUNNING) break; // Paused in between.
    }
    return this.#result(current, produced, lastUsage);
  }

  async #runStep(task, userMessage) {
    const { taskId } = task;
    const state = task.currentState;
    const started = Date.now();
    try {
      const context = await this.#buildContext(task, { state, userMessage });
      this.logger.info('agent.step.start', {
        taskId, state, provider: this.llm.provider, model: this.llm.model,
        contextTokens: context.tokens.total, droppedTurns: context.droppedTurns,
      });

      const completion = await this.llm.complete(context.messages, { json: true });
      const reply = parseAgentReply(completion.content, state);
      const usage = {
        contextTokens: context.tokens.total,
        contextTokensExact: this.tokenCounter.info.exact,
        promptTokens: completion.usage?.promptTokens ?? null,
        completionTokens: completion.usage?.completionTokens ?? null,
        model: completion.model,
      };
      this.logger.info('agent.step.reply', {
        taskId, state, structured: reply.structured, suggestedNext: reply.suggestedNext,
        passed: reply.validation?.passed ?? null, ms: Date.now() - started, ...usage,
      });

      await this.memory.updateWorkMemory(taskId, workUpdatesFrom(reply, state), { state });

      let autoContinue = false;
      const updated = await this.tasks.update(taskId, (t) => {
        const outcome = SM.completeStep(t, {
          suggestedNext: reply.suggestedNext,
          plannedAction: reply.plannedAction,
          needsUserInput: reply.needsUserInput,
          validationPassed: reply.validation?.passed ?? null,
          maxValidationRetries: this.options.maxValidationRetries,
        });
        autoContinue = outcome.autoContinue;
        return { ...outcome.task, lastUsage: usage };
      });

      const proposals = await this.#newProposals(reply.memoryProposals);
      const message = await this.memory.addMessage({
        role: 'assistant',
        content: reply.response,
        taskId,
        task: { ...snapshot(updated), performedState: state, validation: reply.validation },
        proposals,
        usage,
      });
      return { task: updated, message, autoContinue, usage };
    } catch (err) {
      this.logger.warn('agent.step.failed', { taskId, state, code: err.code ?? null, error: err, ms: Date.now() - started });
      throw err;
    }
  }

  async #buildContext(task, { state, userMessage = null, userMessageText, work }) {
    const text = userMessage?.content ?? userMessageText ?? '';
    const [profile, messages, workMemory] = await Promise.all([
      this.profiles.getProfile(),
      this.memory.getShortTermMemory(),
      work ? Promise.resolve(work) : this.memory.getWorkMemory(task.taskId),
    ]);
    const query = [text, workMemory.objective].filter(Boolean).join('\n');
    const { memory: longTerm } = await this.memory.longTerm.selectForContext(query, this.options.longTermContextTokens);
    const turns = ShortTermMemory.toTurns(messages, { excludeId: userMessage?.id });
    return this.contextBuilder.build({ profile, longTerm, work: workMemory, shortTerm: turns, task, state, userMessage: text });
  }

  // --- Helpers --------------------------------------------------------------

  /** Where a new message goes. */
  #routeMessage(task, { forPreview = false } = {}) {
    if (!task || task.status === SM.STATUSES.COMPLETED) return { newTask: true, state: SM.STATES.PLANNING };
    if (task.status === SM.STATUSES.PAUSED) {
      if (forPreview) return { newTask: false, state: task.resumeState, blocked: 'paused' };
      throw conflict('The current task is paused. Resume it, or start a new task.', 'task_paused');
    }
    if (task.status === SM.STATUSES.RUNNING || this.tasks.isBusy(task.taskId)) {
      if (forPreview) return { newTask: false, state: task.currentState, blocked: 'running' };
      throw conflict('The agent is still working on this task. Wait for it to finish.', 'task_busy');
    }
    return { newTask: false, state: SM.stateForUserMessage(task) };
  }

  async #applyMemoryCommands(message, taskId) {
    const { longTerm, work } = extractMemoryCommands(message);
    const updates = [];
    for (const fact of longTerm) {
      const { fact: saved, created } = await this.memory.saveFact({ ...fact, source: 'command' });
      updates.push({ layer: 'longTerm', category: saved.category, content: saved.content, id: saved.id, created });
    }
    if (Object.keys(work).length) {
      await this.memory.updateWorkMemory(taskId, work);
      for (const [field, items] of Object.entries(work)) {
        for (const content of items) updates.push({ layer: 'work', field, content });
      }
    }
    return updates;
  }

  /** Drop suggestions that long-term memory already holds. */
  async #newProposals(proposals) {
    if (!proposals.length) return [];
    const all = await this.memory.getLongTermMemory();
    const known = new Set(Object.values(all).flat().map((item) => item.content.trim().toLowerCase()));
    return proposals.filter((p) => !known.has(p.content.trim().toLowerCase()));
  }

  async #completionMessage(task) {
    const work = await this.memory.getWorkMemory(task.taskId);
    const verdict = work.validationResults.filter((r) => r.passed === true).at(-1);
    const content = verdict ? `Task complete. ${verdict.text}` : 'Task complete.';
    return this.memory.addMessage({ role: 'assistant', kind: 'status', content, taskId: task.taskId, task: snapshot(task) });
  }

  async #result(task, messages, usage = null) {
    const tokens = await this.tokenSummary();
    const lastAnswer = messages.filter((m) => m.role === 'assistant').at(-1);
    return {
      response: lastAnswer?.content ?? null,
      messages,
      task: SM.publicTask(task),
      tokens,
      usage,
    };
  }

  /**
   * After a failure: a task still marked running goes to the error state (so
   * continue retries it), and whatever was produced before the failure is
   * attached to the error, so the UI can still show it.
   */
  async #withResult(err, taskId, produced) {
    const safe = (err instanceof AppError || (typeof err?.code === 'string' && err.status)) ? err.message : 'Internal error.';
    try {
      const task = await this.tasks.update(taskId, (t) => (t.status === SM.STATUSES.RUNNING ? SM.fail(t, safe) : t));
      err.result = await this.#result(task, produced);
    } catch (inner) {
      this.logger.error('agent.result_after_failure', { taskId, error: inner });
    }
    return err;
  }
}

function titleFrom(message) {
  const firstLine = String(message).split('\n').find((line) => line.trim()) ?? 'Task';
  return clip(firstLine, 80);
}

function snapshot(task) {
  return {
    id: task.taskId,
    currentState: task.currentState,
    nextState: task.nextState,
    plannedAction: task.plannedAction,
    mode: task.mode,
    status: task.status,
  };
}

function workUpdatesFrom(reply, state) {
  const { result, ...rest } = reply.workMemory;
  const updates = { ...rest };
  if (state === SM.STATES.VALIDATION && reply.validation) {
    updates.validationResults = [{
      text: reply.validation.summary || (reply.validation.passed ? 'Validation passed.' : 'Validation failed.'),
      passed: reply.validation.passed,
    }];
  } else if (result) {
    updates.intermediateResults = [result];
  } else if (state === SM.STATES.EXECUTION) {
    // Keep a trace of every execution, even when the model gave no summary.
    updates.intermediateResults = [clip(reply.response, 300)];
  }
  return updates;
}
