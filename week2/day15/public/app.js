/*
 * DeepSeek Agent (day 15) — browser client.
 *
 * Talks only to this server's /api; the DeepSeek key never reaches the browser.
 * Everything updates in place. User and model text is inserted with
 * textContent, except agent answers, which go through the escaping Markdown
 * renderer (markdown.js).
 */
(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const state = {
    config: null,
    task: null,
    busy: false,
    messages: [],
    invariants: [],
    profile: null,
    longTermContents: new Set(),
    dismissed: new Set(),
    selectedMode: 'manual',
    pollTimer: null,
    previewTimer: null,
    previewSeq: 0,
    memoryTab: 'short',
    categoryLabels: {},
  };

  // --- DOM helpers -------------------------------------------------------------

  /** h('div', {class: 'x', onclick}, child, 'text') → element. Strings become text nodes. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
  const pad = (n) => String(n).padStart(2, '0');
  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const shortId = (id) => (id ? id.replace(/^task-/, '').slice(0, 8) : '—');

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch { /* Private mode: simply not remembered. */ }
  }

  // --- API ---------------------------------------------------------------------

  class ApiError extends Error {
    constructor(message, { status = 0, code = 'network', data = null } = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.data = data;
    }
  }

  async function api(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = storageGet('deepseek-agent-token');
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetch(`/api${url}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin',
      });
    } catch {
      throw new ApiError('Cannot reach the server. Check your connection and that the service is running.');
    }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (response.status === 401) {
      const dialog = $('#auth-dialog');
      if (!dialog.open) dialog.showModal();
      throw new ApiError('Authentication required.', { status: 401, code: 'unauthorized', data });
    }
    if (!response.ok) {
      throw new ApiError(data?.error || `The server answered with HTTP ${response.status}.`, {
        status: response.status, code: data?.code || 'http_error', data,
      });
    }
    if (data === null) throw new ApiError('The server sent an unreadable response.', { status: response.status, code: 'invalid_response' });
    return data;
  }

  // --- Errors ------------------------------------------------------------------

  function showError(err) {
    const el = $('#error');
    el.textContent = err instanceof Error ? err.message : String(err);
    el.hidden = false;
  }
  function clearError() {
    $('#error').hidden = true;
  }

  // --- Chat --------------------------------------------------------------------

  const chatEl = $('#chat');
  const messagesEl = $('#messages');

  const nearBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 140;
  const scrollToBottom = () => { chatEl.scrollTop = chatEl.scrollHeight; };

  /** "planning (again)" when a stage re-runs with the user's answer or decision. */
  function nextLabel(task) {
    if (!task.nextState) return 'none';
    return task.nextState === task.state ? `${task.nextState} (again)` : task.nextState;
  }

  const MODE_LABEL = { manual: 'Manual', auto: 'Auto' };
  const AWAITING_LABEL = {
    question: 'waiting for your answer',
    invariant_conflict: 'waiting for your decision on an invariant conflict',
    validation_retries: 'waiting for your feedback',
  };

  /** The state information of one answer, exactly as the server stamped it on the message. */
  function stateBlock(task, conflict) {
    if (!task || !task.state) return null;
    return h('div', { class: `state-block${conflict || task.awaiting ? ' state-block--conflict' : ''}` },
      h('span', null, 'Current state: ', h('b', null, task.state), task.awaiting ? ` · ${AWAITING_LABEL[task.awaiting] || task.awaiting}` : ''),
      h('span', null, 'Next state: ', h('b', null, nextLabel(task))),
      h('span', null, 'Planned action: ', task.plannedAction || 'none'),
      task.mode ? h('span', null, 'Mode: ', h('b', null, MODE_LABEL[task.mode] || task.mode)) : '');
  }

  function conflictButtons(conflicts, { compact = false } = {}) {
    const taskId = state.task?.id;
    if (!taskId) return null;
    const firstId = conflicts?.[0]?.invariantId;
    const size = compact ? ' button--small' : '';
    return h('div', { class: 'conflict-actions' },
      h('button', {
        type: 'button', class: `button${size} button--warn`,
        onclick: () => openInvariants({ editId: firstId }),
      }, 'Update invariant'),
      h('button', { type: 'button', class: `button${size}`, onclick: () => resolveConflict('disable') }, 'Disable invariant'),
      h('button', { type: 'button', class: `button${size} button--primary`, onclick: () => resolveConflict('keep') }, 'Keep invariant'),
      h('button', { type: 'button', class: `button${size} button--danger-ghost`, onclick: () => resolveConflict('cancel') }, 'Cancel task'));
  }

  function proposalBlock(message) {
    const items = (message.proposals || []).filter((p) => !state.dismissed.has(`${message.id}:${p.content}`));
    if (!items.length) return null;
    return h('div', { class: 'proposals' }, items.map((p) => {
      const saved = state.longTermContents.has(p.content.trim().toLowerCase());
      const label = p.origin ? `Keep in long-term memory? · ${p.category} · ${p.origin}` : `Suggested for long-term memory · ${p.category}`;
      const row = h('div', { class: 'proposal' },
        h('span', { class: 'proposal__text' },
          h('span', { class: 'proposal__cat' }, label), h('br'), p.content));
      if (saved) {
        row.append(h('span', { class: 'muted' }, 'saved ✓'));
        return row;
      }
      row.append(
        h('button', {
          type: 'button', class: 'button button--small button--primary',
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              const data = await api('POST', '/memory/long-term', { category: p.category, content: p.content, source: p.origin ? 'promotion' : 'proposal' });
              rememberLongTerm(data.longTerm);
              applyTokens(data.tokens);
              row.replaceChildren(h('span', { class: 'proposal__text' }, p.content), h('span', { class: 'muted' }, 'saved ✓'));
            } catch (err) {
              event.target.disabled = false;
              showError(err);
            }
          },
        }, 'Save'),
        h('button', {
          type: 'button', class: 'button button--small button--ghost',
          onclick: () => { state.dismissed.add(`${message.id}:${p.content}`); row.remove(); },
        }, 'Dismiss'));
      return row;
    }));
  }

  function renderMessage(m) {
    if (m.kind === 'status' || m.kind === 'error') {
      return h('div', { class: `note${m.kind === 'error' ? ' note--error' : ''}`, dataset: { id: m.id } },
        h('time', { datetime: m.timestamp }, fmtDateTime(m.timestamp)), m.content, proposalBlock(m) || '');
    }
    const isUser = m.role === 'user';
    const isConflict = m.kind === 'conflict';
    const body = h('div', { class: 'bubble__body' });
    if (isUser) body.textContent = m.content;
    else body.innerHTML = window.Markdown.render(m.content);

    const bubble = h('article', {
      class: `bubble ${isUser ? 'bubble--user' : 'bubble--agent'}${isConflict ? ' bubble--conflict' : ''}`,
      dataset: { id: m.id },
    },
    h('header', { class: 'bubble__head' },
      h('span', { class: 'bubble__tag' }, m.tag || (isUser ? 'you asked' : 'agent answered')),
      h('time', { class: 'bubble__time', datetime: m.timestamp }, fmtDateTime(m.timestamp))),
    body);

    if (!isUser) {
      bubble.append(stateBlock(m.task, isConflict) || '');
      if (m.rejectedTransition) {
        const r = m.rejectedTransition;
        bubble.append(h('div', { class: 'bubble__check' }, h('b', null, 'Transition rejected: '),
          `the agent proposed ${r.from} → ${r.to}, but ${r.reason}. The task keeps its lifecycle.`));
      }
      if (m.profileCheck) {
        const pc = m.profileCheck;
        bubble.append(pc.ok
          ? h('div', { class: 'bubble__check bubble__check--ok' }, h('b', null, 'Profile check: '),
            `the first response broke your profile and was corrected (${pc.revisions} correction${pc.revisions === 1 ? '' : 's'}).`)
          : h('div', { class: 'bubble__check' }, h('b', null, 'Profile check: '),
            `this answer still breaks your profile after ${pc.revisions} correction${pc.revisions === 1 ? '' : 's'}: `,
            pc.issues.map((i) => i.message).join(' ')));
      }
      bubble.append(proposalBlock(m) || '');
      const meta = [];
      if (m.task?.performedState) meta.push(`step: ${m.task.performedState}`);
      if (m.validation) meta.push(`validation: ${m.validation.passed ? 'passed' : 'failed'}`);
      if (m.usage?.promptTokens != null) {
        meta.push(`DeepSeek: ${fmtNum(m.usage.promptTokens)} in / ${fmtNum(m.usage.completionTokens)} out`);
      }
      if (m.usage?.calls > 1) meta.push(`${m.usage.calls} calls`);
      if (meta.length) bubble.append(h('div', { class: 'bubble__meta' }, meta.join(' · ')));
    }
    return bubble;
  }

  function renderChat({ keepScroll = false } = {}) {
    const stick = !keepScroll || nearBottom();
    messagesEl.replaceChildren(...state.messages.map(renderMessage));
    if (state.busy) messagesEl.append(h('div', { class: 'typing', id: 'typing' }, typingText()));
    $('#empty').hidden = state.messages.length > 0 || state.busy;
    if (stick) scrollToBottom();
  }

  function typingText() {
    const t = state.task;
    if (t?.stepStatus === 'running') return `agent is working · ${t.state}`;
    return 'agent is working';
  }

  function addMessages(list) {
    const known = new Set(state.messages.map((m) => m.id));
    for (const m of list || []) if (!known.has(m.id)) state.messages.push(m);
  }

  // --- Task panel ----------------------------------------------------------------

  const STEPS = ['planning', 'execution', 'validation', 'done'];
  const isFinal = (t) => t && (t.state === 'done' || t.state === 'cancelled');

  /**
   * The task as the server returned it: side panel, stepper and the task bar
   * above the form. Only the controls that are valid right now are shown.
   */
  function renderTask() {
    const t = state.task;
    const running = state.busy || t?.stepStatus === 'running';
    const awaiting = t?.awaitingInput?.reason || null;

    // Side panel.
    $('#task-id').textContent = t ? shortId(t.id) : '—';
    $('#task-id').title = t?.id || '';
    $('#task-mode').textContent = t ? MODE_LABEL[t.mode] : '—';
    $('#task-current').textContent = t ? t.state : '—';
    $('#task-next').textContent = t ? nextLabel(t) : '—';
    $('#task-objective').textContent = t?.objective || '—';
    $('#task-current-action').textContent = t?.currentAction || '—';
    $('#task-action').textContent = t ? t.plannedAction : 'Ask a question to start a task.';
    $('#task-allowed').textContent = t ? (t.allowedTransitions.length ? t.allowedTransitions.join(', ') : 'none (final)') : '—';
    const v = t?.validation;
    $('#task-validation').textContent = !v ? '—'
      : v.lastVerdict ? `${v.lastVerdict.passed ? 'passed' : 'failed'}${v.lastVerdict.summary ? ` — ${v.lastVerdict.summary}` : ''} (failed attempts: ${v.attempts})`
        : 'not validated yet';
    $('#task-history-count').textContent = String(t?.history?.length || 0);
    $('#task-history').textContent = (t?.history || []).map((x) => `${fmtDateTime(x.timestamp)}  ${x.from || '∅'} → ${x.to}  ${x.reason || ''}`).join('\n')
      + ((t?.rejectedTransitions || []).length ? `\n\nRejected proposals:\n${t.rejectedTransitions.map((r) => `${fmtDateTime(r.at)}  ${r.from} → ${r.to}: ${r.reason}`).join('\n')}` : '');

    const status = $('#task-status');
    let label = 'no task';
    let cls = '';
    if (t) {
      if (running) { label = `running · ${t.state}`; cls = 'pill--accent'; }
      else if (t.state === 'paused') { label = `paused in ${t.resumeState}`; cls = 'pill--warn'; }
      else if (t.state === 'done') { label = 'done'; cls = 'pill--ok'; }
      else if (t.state === 'cancelled') { label = 'cancelled'; cls = 'pill--danger'; }
      else if (t.state === 'failed') { label = 'failed · retry possible'; cls = 'pill--danger'; }
      else if (awaiting) { label = awaiting === 'invariant_conflict' ? 'invariant conflict' : 'waiting for you'; cls = 'pill--warn'; }
      else if (t.stepStatus === 'pending') { label = 'ready'; }
      else { label = t.mode === 'manual' ? 'waiting for continue' : 'step finished'; }
      if (t.pauseRequested) label += ' · pause requested';
    }
    status.textContent = label;
    status.className = `pill ${cls}`;

    // Stepper: past / current, with paused and failed shown on the stage they belong to.
    const shown = t ? (['paused', 'failed'].includes(t.state) ? t.resumeState : t.state) : null;
    const at = STEPS.indexOf(shown);
    $$('#stepper li').forEach((li) => {
      const i = STEPS.indexOf(li.dataset.state);
      li.classList.toggle('is-current', Boolean(t) && i === at);
      li.classList.toggle('is-past', Boolean(t) && at >= 0 && i < at);
    });
    $$('.segmented button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.selectedMode)));

    // Task bar.
    const bar = $('#taskbar');
    bar.hidden = !t;
    if (t) {
      bar.classList.toggle('is-waiting', Boolean(awaiting) || t.state === 'paused' || t.state === 'failed');
      bar.classList.toggle('is-final', isFinal(t));
      $('#tb-current').textContent = t.state;
      $('#tb-next').textContent = nextLabel(t);
      $('#tb-mode').textContent = MODE_LABEL[t.mode];
      $('#tb-action').textContent = t.plannedAction || 'none';
      const pill = $('#tb-status');
      pill.textContent = label;
      pill.className = `pill ${cls}`;
    }
    const active = t && t.status === 'active' && !running;
    const show = {
      continue: active && !awaiting && t.nextState || (t?.state === 'failed' && !running) || (active && awaiting === 'validation_retries'),
      pause: t && t.status === 'active' && !t.pauseRequested,
      resume: t && t.state === 'paused' && !running,
      auto: t && !isFinal(t) && t.mode === 'manual' && !running,
      manual: t && !isFinal(t) && t.mode === 'auto',
      newTask: t && !running,
      cancel: t && !isFinal(t) && !running,
    };
    $('#btn-continue').hidden = !show.continue;
    $('#btn-continue').textContent = t?.state === 'failed' ? 'Retry' : (t?.nextState === 'done' ? 'Finish' : 'Continue');
    $('#btn-pause').hidden = !show.pause;
    $('#btn-resume').hidden = !show.resume;
    $('#btn-auto').hidden = !show.auto;
    $('#btn-manual').hidden = !show.manual;
    $('#btn-new-task').hidden = !show.newTask;
    $('#btn-cancel').hidden = !show.cancel;

    const errEl = $('#task-error');
    errEl.hidden = !(t?.state === 'failed' && t.lastError);
    errEl.textContent = t?.lastError ? `Last error: ${t.lastError}` : '';

    const box = $('#conflict-box');
    if (t?.pendingConflict && awaiting === 'invariant_conflict' && !running) {
      const names = [...new Set(t.pendingConflict.conflicts.map((c) => c.name))];
      box.replaceChildren(
        h('strong', null, `Conflict with ${names.map((n) => `"${n}"`).join(', ')}`),
        h('div', null, 'The agent stopped instead of violating the invariant. Change the invariant, or keep it.'),
        conflictButtons(t.pendingConflict.conflicts, { compact: true }),
        h('div', { class: 'row' }, h('button', {
          type: 'button', class: 'button button--small button--ghost', onclick: () => resolveConflict('updated'),
        }, 'I edited it — continue')));
      box.hidden = false;
    } else {
      box.hidden = true;
    }

    // Where the next question goes.
    let hint = 'Your question starts a new task.';
    if (t && t.state === 'paused') hint = 'The task is paused: resume it, or start a new task first.';
    else if (t && running) hint = 'The agent is working on this task…';
    else if (t && awaiting === 'question') hint = 'Your message answers the agent and continues the task.';
    else if (t && awaiting === 'invariant_conflict') hint = 'Decide on the conflict, or send a changed request.';
    else if (t && t.status === 'active') hint = `Your message is input for the ${t.state === 'validation' ? 'execution' : t.state} step of this task.`;
    else if (t && t.state === 'failed') hint = `Your message retries the ${t.resumeState} step.`;
    $('#route-hint').textContent = hint;
    updateAskButton();
  }

  function applyTask(task) {
    state.task = task || null;
    renderTask();
  }

  // --- Tokens -----------------------------------------------------------------------

  function applyTokens(tokens) {
    if (!tokens) return;
    $('#tok-short').textContent = fmtNum(tokens.shortTerm);
    $('#tok-work').textContent = fmtNum(tokens.work);
    $('#tok-long').textContent = fmtNum(tokens.longTerm);
    $('#tok-context').textContent = fmtNum(tokens.currentContext);
    const method = $('#tok-method');
    method.textContent = tokens.exact ? 'exact tokenizer' : 'estimated';
    method.className = `pill ${tokens.exact ? 'pill--ok' : 'pill--warn'}`;
    method.title = tokens.exact
      ? 'Counted with DeepSeek\'s tokenizer on the exact context the ContextBuilder assembles.'
      : 'DeepSeek\'s tokenizer is not installed; counts are a heuristic estimate (±15%).';
    const b = tokens.breakdown;
    if (b) {
      $('#tok-breakdown').textContent = `context = system ${fmtNum(b.system)} · profile ${fmtNum(b.profile)} · invariants ${fmtNum(b.invariants)}`
        + ` · task ${fmtNum(b.task)} · work ${fmtNum(b.work)} · long-term (relevant) ${fmtNum(b.longTerm)} · short-term ${fmtNum(b.shortTerm)}`
        + ` · task state ${fmtNum(b.taskState)} · request ${fmtNum(b.request)}${tokens.droppedTurns ? ` · ${tokens.droppedTurns} old turns dropped` : ''}`;
    }
    const usage = $('#last-usage');
    if (tokens.apiInput != null) {
      usage.hidden = false;
      usage.replaceChildren(
        h('b', null, 'Last DeepSeek call (reported by the API, authoritative)'), h('br'),
        `input ${fmtNum(tokens.apiInput)} · output ${fmtNum(tokens.apiOutput)} · total ${fmtNum(tokens.total)}`,
        tokens.lastCallContext != null ? h('span', { class: 'muted' }, ` · counted before sending: ${fmtNum(tokens.lastCallContext)}`) : '');
    } else {
      usage.hidden = true;
    }
  }

  function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(async () => {
      const seq = ++state.previewSeq;
      try {
        const data = await api('POST', '/token-counts', { message: $('#question').value });
        if (seq === state.previewSeq) applyTokens(data.tokens);
      } catch { /* The next keystroke retries. */ }
    }, 350);
  }

  // --- Composer -----------------------------------------------------------------------

  const input = $('#question');

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.3)}px`;
  }

  function updateAskButton() {
    const t = state.task;
    const blocked = state.busy || t?.state === 'paused' || t?.stepStatus === 'running';
    $('#btn-ask').disabled = blocked || !input.value.trim();
  }

  function setBusy(busy) {
    state.busy = busy;
    if (busy) startPolling(); else stopPolling();
    renderChat({ keepScroll: true });
    renderTask();
  }

  /** Apply what any agent operation returns: messages, task, tokens. */
  function applyResult(data) {
    if (!data) return;
    addMessages(data.messages);
    if ('task' in data) applyTask(data.task);
    applyTokens(data.tokens);
    renderChat();
  }

  async function runAgent(promise) {
    clearError();
    setBusy(true);
    try {
      applyResult(await promise);
    } catch (err) {
      if (err.data?.result) applyResult(err.data.result);
      showError(err);
    } finally {
      setBusy(false);
      refreshLongTerm();
    }
  }

  $('#ask-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || $('#btn-ask').disabled) return;
    input.value = '';
    autosize();
    // Show the question at once; the server's copy replaces it.
    const pending = { id: `pending-${Date.now()}`, role: 'user', tag: 'you asked', content: message, timestamp: new Date().toISOString() };
    state.messages.push(pending);
    renderChat();
    const mode = state.task && !isFinal(state.task) ? undefined : state.selectedMode;
    const promise = api('POST', '/ask', mode ? { message, mode } : { message });
    promise.finally(() => {
      state.messages = state.messages.filter((m) => m.id !== pending.id);
    }).catch(() => {});
    await runAgent(promise.catch((err) => {
      if (!err.data?.result) input.value = message; // Nothing was saved: give the text back.
      throw err;
    }));
    schedulePreview();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#ask-form').requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    autosize();
    updateAskButton();
    schedulePreview();
  });

  // --- Task controls -------------------------------------------------------------

  $('#btn-continue').addEventListener('click', () => {
    if (state.task) runAgent(api('POST', `/tasks/${state.task.id}/continue`));
  });
  $('#btn-resume').addEventListener('click', () => {
    if (state.task) runAgent(api('POST', `/tasks/${state.task.id}/resume`));
  });
  $('#btn-pause').addEventListener('click', async () => {
    if (!state.task) return;
    try {
      const data = await api('POST', `/tasks/${state.task.id}/pause`);
      if (!state.busy) applyResult(data); else applyTask(data.task);
    } catch (err) {
      showError(err);
    }
  });
  $('#btn-auto').addEventListener('click', () => {
    if (state.task) runAgent(api('POST', `/tasks/${state.task.id}/auto`));
  });
  $('#btn-manual').addEventListener('click', async () => {
    if (!state.task) return;
    try {
      // Works while an auto run is in progress: it stops after the running step.
      const data = await api('POST', `/tasks/${state.task.id}/manual`);
      if (!state.busy) applyResult(data); else applyTask(data.task);
    } catch (err) {
      showError(err);
    }
  });
  $('#btn-new-task').addEventListener('click', async () => {
    try {
      applyResult(await api('DELETE', '/tasks/active'));
      input.focus();
    } catch (err) {
      showError(err);
    }
  });
  $('#btn-cancel').addEventListener('click', async () => {
    if (!state.task) return;
    try {
      applyResult(await api('POST', `/tasks/${state.task.id}/cancel`));
    } catch (err) {
      showError(err);
    }
  });
  // The mode a new task starts in (the current task has its own Switch buttons).
  $$('.segmented button').forEach((button) => button.addEventListener('click', () => {
    state.selectedMode = button.dataset.mode;
    storageSet('deepseek-agent-mode', state.selectedMode);
    renderTask();
  }));

  async function resolveConflict(decision) {
    if (!state.task) return;
    await runAgent(api('POST', `/tasks/${state.task.id}/resolve`, { decision }));
    loadInvariants();
  }

  // While a request runs, show the task's live state (auto mode moves through several).
  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      try {
        const data = await api('GET', '/tasks/active');
        if (!state.busy) return;
        state.task = data.task;
        renderTask();
        const typing = $('#typing');
        if (typing) typing.textContent = typingText();
      } catch { /* The request itself reports errors. */ }
    }, 1200);
  }
  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // --- Side panel toggle (narrow screens) -------------------------------------------

  function toggleSide(force) {
    const side = $('#side');
    // Below the header, whose height depends on how its buttons wrap.
    side.style.top = `${$('.topbar').offsetHeight}px`;
    const open = side.classList.toggle('is-open', force);
    $('#btn-side').setAttribute('aria-expanded', String(open));
  }
  $('#btn-side').addEventListener('click', () => toggleSide());
  $('.chat-column').addEventListener('click', () => {
    if ($('#side').classList.contains('is-open')) toggleSide(false);
  });

  // --- Profile modal ------------------------------------------------------------------

  const profileDialog = $('#profile-dialog');
  const PROFILE_FIELDS = ['style', 'format', 'limitations'];

  function renderProfileView(data) {
    state.profile = data.profile;
    $('#profile-dot').hidden = !data.profile || !PROFILE_FIELDS.some((f) => data.profile[f]);
    $('#profile-state').textContent = data.profile
      ? `Last saved ${fmtDateTime(data.profile.updatedAt)}.${PROFILE_FIELDS.some((f) => data.profile[f]) ? '' : ' All fields are empty.'}`
      : 'No profile yet. Fill in any field and save to create it.';
    $('#profile-preview').textContent = data.contextSection;
    $('#profile-tokens').textContent = fmtNum(data.contextTokens);
    $('#profile-delete').disabled = !data.profile;
    $('#profile-clear').disabled = !data.profile;
    if (data.tokens) applyTokens(data.tokens);
  }

  function buildProfileFields(fields, profile) {
    const wrap = $('#profile-fields');
    wrap.replaceChildren(...PROFILE_FIELDS.map((name) => {
      const spec = fields[name];
      const ta = h('textarea', { class: 'input', id: `profile-${name}`, rows: 2, maxlength: spec.max, placeholder: spec.hint });
      ta.value = profile?.[name] || '';
      return h('label', { class: 'field' }, h('span', { class: 'field__label' }, spec.label), ta, h('span', { class: 'field__hint' }, spec.hint));
    }));
  }

  async function openProfile() {
    $('#profile-status').textContent = '';
    $('#profile-confirm').hidden = true;
    try {
      const data = await api('GET', '/profile');
      buildProfileFields(data.fields, data.profile);
      renderProfileView(data);
      profileDialog.showModal();
      $('#profile-style').focus();
    } catch (err) {
      showError(err);
    }
  }

  $('#btn-profile').addEventListener('click', openProfile);
  $('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, $(`#profile-${f}`).value]));
    try {
      const data = await api('PUT', '/profile', body);
      renderProfileView(data);
      $('#profile-status').textContent = 'Saved. The next request uses this profile.';
    } catch (err) {
      $('#profile-status').textContent = err.message;
    }
  });
  $('#profile-clear').addEventListener('click', async () => {
    try {
      const data = await api('POST', '/profile/clear');
      buildProfileFields(data.fields, data.profile);
      renderProfileView(data);
      $('#profile-status').textContent = 'Cleared. The profile exists but is empty.';
    } catch (err) {
      $('#profile-status').textContent = err.message;
    }
  });
  $('#profile-delete').addEventListener('click', () => { $('#profile-confirm').hidden = false; });
  $('#profile-delete-no').addEventListener('click', () => { $('#profile-confirm').hidden = true; });
  $('#profile-delete-yes').addEventListener('click', async () => {
    try {
      const data = await api('DELETE', '/profile');
      buildProfileFields(data.fields, null);
      renderProfileView(data);
      $('#profile-confirm').hidden = true;
      $('#profile-status').textContent = 'Profile deleted.';
    } catch (err) {
      $('#profile-status').textContent = err.message;
    }
  });

  // --- Invariants ------------------------------------------------------------------------

  const invDialog = $('#invariants-dialog');

  function renderInvariantsSide() {
    const list = $('#inv-side');
    const active = state.invariants.filter((i) => i.enabled).length;
    $('#inv-count').textContent = String(active);
    if (!state.invariants.length) {
      list.replaceChildren(h('li', { class: 'muted' }, 'No invariants. Add some under "Manage".'));
      return;
    }
    list.replaceChildren(...state.invariants.map((inv) => h('li', { class: inv.enabled ? '' : 'is-off' },
      h('span', { class: 'inv-name' }, `${inv.name}${inv.enabled ? '' : ' (disabled)'}`,
        h('span', { class: 'muted' }, ` · ${state.categoryLabels[inv.category] || inv.category}`)),
      h('span', { class: 'inv-value' }, inv.value))));
  }

  function renderInvariantsModal(data) {
    const list = $('#inv-list');
    if (!data.invariants.length) {
      list.replaceChildren(h('p', { class: 'muted' }, 'No invariants yet. Create one below, or add the examples.'));
    } else {
      list.replaceChildren(...data.invariants.map((inv) => h('div', { class: `inv-card${inv.enabled ? '' : ' is-off'}` },
        h('div', null,
          h('div', { class: 'inv-card__title' }, inv.name),
          h('div', { class: 'inv-card__meta' }, `${inv.id} · ${data.categoryLabels[inv.category] || inv.category} · ${inv.enabled ? 'enabled' : 'disabled'}`
            + `${inv.forbidden.length ? ` · forbidden: ${inv.forbidden.join(', ')}` : ''}`)),
        h('div', { class: 'inv-card__actions' },
          h('button', {
            type: 'button', class: 'button button--small',
            onclick: () => invariantRequest('PUT', `/invariants/${inv.id}`, { enabled: !inv.enabled }, inv.enabled ? 'Disabled.' : 'Enabled.'),
          }, inv.enabled ? 'Disable' : 'Enable'),
          h('button', { type: 'button', class: 'button button--small', onclick: () => editInvariant(inv) }, 'Edit'),
          h('button', {
            type: 'button', class: 'button button--small button--danger-ghost',
            onclick: (event) => {
              if (event.target.dataset.confirm) {
                invariantRequest('DELETE', `/invariants/${inv.id}`, undefined, 'Deleted.');
              } else {
                event.target.dataset.confirm = '1';
                event.target.textContent = 'Confirm delete';
              }
            },
          }, 'Delete')),
        h('div', { class: 'inv-card__value' }, inv.value))));
    }
    $('#inv-preview').textContent = data.contextSection;
    $('#inv-tokens').textContent = fmtNum(data.contextTokens);
    const select = $('#inv-category');
    if (!select.options.length) data.categories.forEach((c) => select.append(h('option', { value: c }, data.categoryLabels[c] || c)));
  }

  function applyInvariants(data) {
    state.invariants = data.invariants;
    state.categoryLabels = data.categoryLabels || {};
    renderInvariantsSide();
    renderInvariantsModal(data);
    if (data.tokens) applyTokens(data.tokens);
  }

  async function loadInvariants() {
    try {
      applyInvariants(await api('GET', '/invariants'));
    } catch { /* Shown when the modal is opened. */ }
  }

  async function invariantRequest(method, url, body, done) {
    $('#inv-status').textContent = '';
    try {
      const data = await api(method, url, body);
      applyInvariants(data);
      $('#inv-status').textContent = done;
      return data;
    } catch (err) {
      $('#inv-status').textContent = err.message;
      return null;
    }
  }

  function resetInvariantForm() {
    $('#inv-edit-id').value = '';
    $('#inv-name').value = '';
    $('#inv-value').value = '';
    $('#inv-category').value = 'technicalSolutions';
    $('#inv-forbidden').value = '';
    $('#inv-enabled').checked = true;
    $('#inv-form-title').textContent = 'New invariant';
    $('#inv-submit').textContent = 'Create invariant';
    $('#inv-cancel-edit').hidden = true;
  }

  function editInvariant(inv) {
    $('#inv-edit-id').value = inv.id;
    $('#inv-name').value = inv.name;
    $('#inv-value').value = inv.value;
    $('#inv-category').value = inv.category;
    $('#inv-forbidden').value = inv.forbidden.join(', ');
    $('#inv-enabled').checked = inv.enabled;
    $('#inv-form-title').textContent = `Edit invariant "${inv.id}"`;
    $('#inv-submit').textContent = 'Save invariant';
    $('#inv-cancel-edit').hidden = false;
    $('#inv-value').focus();
  }

  async function openInvariants({ editId } = {}) {
    $('#inv-status').textContent = '';
    try {
      applyInvariants(await api('GET', '/invariants'));
    } catch (err) {
      showError(err);
      return;
    }
    resetInvariantForm();
    if (!invDialog.open) invDialog.showModal();
    const inv = editId && state.invariants.find((i) => i.id === editId);
    if (inv) {
      editInvariant(inv);
      $('#inv-status').textContent = 'Edit the rule, save, then choose "I edited it — continue" on the task.';
    }
  }

  $('#btn-open-invariants').addEventListener('click', () => openInvariants());
  $('#btn-manage-invariants').addEventListener('click', () => openInvariants());
  $('#inv-cancel-edit').addEventListener('click', resetInvariantForm);
  $('#inv-examples').addEventListener('click', () => invariantRequest('POST', '/invariants/examples', undefined, 'Examples added.'));
  $('#inv-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#inv-edit-id').value;
    const body = {
      name: $('#inv-name').value,
      value: $('#inv-value').value,
      category: $('#inv-category').value,
      enabled: $('#inv-enabled').checked,
      forbidden: $('#inv-forbidden').value.split(',').map((s) => s.trim()).filter(Boolean),
    };
    const data = id
      ? await invariantRequest('PUT', `/invariants/${id}`, body, 'Saved. The next request uses it.')
      : await invariantRequest('POST', '/invariants', body, 'Created. The next request uses it.');
    if (data) resetInvariantForm();
  });
  $('#inv-test-run').addEventListener('click', async () => {
    const text = $('#inv-test').value.trim();
    if (!text) return;
    try {
      const result = await api('POST', '/invariants/check', { text, type: 'request' });
      $('#inv-test-out').textContent = result.ok ? 'No conflict detected by the rules. (The model also checks every request.)'
        : result.conflicts.map((c) => `✗ ${c.name}: ${c.reason}`).join('\n');
    } catch (err) {
      $('#inv-test-out').textContent = err.message;
    }
  });

  // --- Memory inspector ----------------------------------------------------------------

  const memDialog = $('#memory-dialog');
  const memBody = $('#memory-body');

  function memStatus(text) {
    $('#memory-status').textContent = text || '';
  }

  async function openMemory(tab) {
    state.memoryTab = tab || state.memoryTab;
    memStatus('');
    if (!memDialog.open) memDialog.showModal();
    await renderMemoryTab();
  }

  $$('[data-open-memory]').forEach((b) => b.addEventListener('click', () => openMemory(b.dataset.openMemory)));
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => openMemory(b.dataset.tab)));

  async function renderMemoryTab() {
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.memoryTab)));
    memBody.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const render = { short: tabShort, work: tabWork, long: tabLong, storage: tabStorage, tasks: tabTasks, context: tabContext }[state.memoryTab];
      memBody.replaceChildren(...[await render()].flat());
    } catch (err) {
      memBody.replaceChildren(h('p', { class: 'note note--error' }, err.message));
    }
  }

  const act = (label, fn, cls = '') => h('button', {
    type: 'button', class: `button button--small ${cls}`,
    onclick: async () => {
      try {
        const data = await fn();
        if (data?.tokens) applyTokens(data.tokens);
        await renderMemoryTab();
      } catch (err) {
        memStatus(err.message);
      }
    },
  }, label);

  async function tabShort() {
    const data = await api('GET', '/memory/short-term');
    return [
      h('div', { class: 'section-title' },
        h('span', null, `Short-term memory · ${data.messages.length} messages · ${fmtNum(data.tokens)} tokens · ${data.storage.location} (${data.storage.provider})`),
        act('Clear short-term memory', () => api('DELETE', '/memory/short-term'), 'button--danger-ghost')),
      h('p', { class: 'muted' }, 'The recent conversation the agent remembers and replays to DeepSeek. Clearing it does not delete the visible chat history (data/history/chat-history.json).'),
      data.messages.length
        ? h('ul', { class: 'item-list' }, data.messages.map((m) => h('li', null,
          h('span', null, h('b', null, `${m.role}${m.state ? ` · ${m.state}` : ''} · ${fmtDateTime(m.timestamp)}: `), m.content.slice(0, 400) + (m.content.length > 400 ? '…' : '')),
          h('span', { class: 'item-actions' }, act('Forget', () => api('DELETE', `/memory/short-term/${m.id}`))))))
        : h('p', { class: 'muted' }, 'Empty.'),
    ];
  }

  async function tabWork() {
    const data = await api('GET', '/memory/work');
    const taskId = data.activeTaskId;
    const doc = taskId ? data.tasks[taskId] : null;
    const out = [h('div', { class: 'section-title' },
      h('span', null, `Work memory of the active task · ${fmtNum(data.tokens)} tokens · ${data.storage.location} (${data.storage.provider})`),
      taskId ? act('Clear', () => api('DELETE', `/memory/work/${taskId}`), 'button--danger-ghost') : '')];
    if (!doc) {
      out.push(h('p', { class: 'muted' }, 'No active task. Work memory belongs to a task; ask a question to start one.'));
      return out;
    }
    out.push(h('p', { class: 'muted' }, `Task ${taskId}. "Promote" copies an item to long-term memory; nothing is promoted automatically.`));

    const promote = (field, index, text) => h('span', { class: 'item-actions' },
      act('→ solutions', () => api('POST', '/memory/promote', { taskId, field, index, category: 'solutions' })),
      act('→ knowledge', () => api('POST', '/memory/promote', { taskId, field, index, category: 'knowledge' })),
      text !== undefined && ['requirements', 'decisions', 'facts', 'plan'].includes(field)
        ? act('Delete', () => api('DELETE', `/memory/work/${taskId}/items`, { field, index }), 'button--danger-ghost') : '');

    out.push(h('div', { class: 'section-title' }, 'Objective'),
      h('ul', { class: 'item-list' }, h('li', null, h('span', null, doc.objective || '—'), doc.objective ? promote('objective') : '')));
    const lists = [['plan', 'Plan'], ['requirements', 'Requirements'], ['decisions', 'Decisions'], ['facts', 'Facts']];
    for (const [field, label] of lists) {
      const items = doc[field] || [];
      out.push(h('div', { class: 'section-title' }, `${label} (${items.length})`));
      out.push(items.length ? h('ul', { class: 'item-list' }, items.map((text, i) => h('li', null, h('span', null, text), promote(field, i, text))))
        : h('p', { class: 'muted' }, '—'));
      if (field !== 'plan') out.push(addWorkItemRow(taskId, field));
    }
    for (const [field, label] of [['intermediateResults', 'Intermediate results'], ['validationResults', 'Validation results']]) {
      const items = doc[field] || [];
      out.push(h('div', { class: 'section-title' }, `${label} (${items.length})`));
      out.push(items.length ? h('ul', { class: 'item-list' }, items.map((r, i) => h('li', null,
        h('span', null, `[${r.state}${typeof r.passed === 'boolean' ? (r.passed ? ' ✓' : ' ✗') : ''}] ${r.text}`), promote(field, i))))
        : h('p', { class: 'muted' }, '—'));
    }
    const vars = Object.entries(doc.variables || {});
    out.push(h('div', { class: 'section-title' }, `Variables (${vars.length})`),
      vars.length ? h('ul', { class: 'item-list' }, vars.map(([k, v]) => h('li', null, h('span', null, `${k} = ${v}`)))) : h('p', { class: 'muted' }, '—'));
    out.push(h('div', { class: 'section-title' }, `Invariant checks (${doc.invariantChecks.length})`),
      doc.invariantChecks.length ? h('ul', { class: 'item-list' }, doc.invariantChecks.slice().reverse().map((c) => h('li', null,
        h('span', null, `${fmtDateTime(c.timestamp)} · ${c.stage} · ${c.ok ? 'ok' : `conflict: ${c.conflicts.map((x) => `${x.name} (${x.method})`).join(', ')}`}${c.resolution ? ` · ${c.resolution}` : ''}`)))) : h('p', { class: 'muted' }, '—'));
    out.push(h('details', { class: 'preview' }, h('summary', null, `Update log (${doc.log.length})`),
      h('pre', null, doc.log.map((l) => `${l.timestamp}  ${l.source}${l.state ? `/${l.state}` : ''}  ${l.fields.join(', ')}`).join('\n'))));
    return out;
  }

  function addWorkItemRow(taskId, field) {
    const inputEl = h('input', { class: 'input', placeholder: `Add to ${field}…`, maxlength: 1000 });
    return h('div', { class: 'row' }, inputEl, act('Add', () => {
      if (!inputEl.value.trim()) throw new Error('Type something to add.');
      return api('POST', `/memory/work/${taskId}/items`, { field, content: inputEl.value });
    }));
  }

  async function tabLong() {
    const data = await api('GET', '/memory/long-term');
    rememberLongTerm(data);
    const out = [h('div', { class: 'section-title' },
      h('span', null, `Long-term memory · ${fmtNum(data.tokens)} tokens · ${data.storage.location} (${data.storage.provider})`))];
    out.push(h('p', { class: 'muted' }, 'Only entries relevant to the current request (keywords, #tags, ids) or pinned ones are sent to DeepSeek. The profile is part of this layer and is sent with every request.'));
    out.push(h('div', { class: 'section-title' }, h('span', null, 'Profile'), h('button', { type: 'button', class: 'button button--small', onclick: () => { memDialog.close(); openProfile(); } }, 'Edit profile')));
    out.push(h('ul', { class: 'item-list' }, ['style', 'format', 'limitations'].map((f) => h('li', null, h('span', null, `${f}: ${data.profile?.[f] || '—'}`)))));
    for (const category of ['solutions', 'knowledge']) {
      const items = data[category];
      out.push(h('div', { class: 'section-title' }, `${category[0].toUpperCase()}${category.slice(1)} (${items.length})`));
      out.push(items.length ? h('ul', { class: 'item-list' }, items.map((e) => h('li', null,
        h('span', null, `${e.pinned ? '📌 ' : ''}${e.content}${e.tags.length ? `  #${e.tags.join(' #')}` : ''}`, h('br'), h('small', { class: 'muted' }, `${e.id} · ${e.source}`)),
        h('span', { class: 'item-actions' },
          act(e.pinned ? 'Unpin' : 'Pin', () => api('PUT', `/memory/long-term/${e.id}`, { pinned: !e.pinned })),
          act('Delete', () => api('DELETE', `/memory/long-term/${e.id}`), 'button--danger-ghost')))))
        : h('p', { class: 'muted' }, '—'));
    }
    const content = h('input', { class: 'input', placeholder: 'New entry…', maxlength: 2000 });
    const tags = h('input', { class: 'input', placeholder: 'tags, comma-separated', style: 'max-width:200px' });
    const category = h('select', { class: 'input', style: 'max-width:140px' }, h('option', { value: 'knowledge' }, 'knowledge'), h('option', { value: 'solutions' }, 'solutions'));
    out.push(h('div', { class: 'section-title' }, 'Add entry'), h('div', { class: 'row' }, content, tags, category, act('Add', () => {
      if (!content.value.trim()) throw new Error('Type the entry first.');
      return api('POST', '/memory/long-term', {
        category: category.value, content: content.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      });
    }, 'button--primary')));

    const q = h('input', { class: 'input', placeholder: 'Test retrieval: type a request…' });
    const outPre = h('pre', { class: 'pre' });
    out.push(h('div', { class: 'section-title' }, 'Retrieval test'), h('div', { class: 'row' }, q, h('button', {
      type: 'button', class: 'button button--small',
      onclick: async () => {
        const r = await api('GET', `/memory/long-term?q=${encodeURIComponent(q.value)}`);
        outPre.textContent = r.retrieval.selected.length
          ? r.retrieval.selected.map((s) => `${s.id} (${s.category}) score ${s.score}: ${s.reasons.join(', ')}`).join('\n')
          : `Nothing relevant among ${r.retrieval.considered} entries — no long-term entry would be sent.`;
      },
    }, 'Show selection')), outPre);
    return out;
  }

  async function tabStorage() {
    const data = await api('GET', '/memory/storage');
    const rows = Object.entries(data.layers).map(([id, layer]) => {
      const select = h('select', { class: 'input' }, data.providers.map((p) => h('option', { value: p.type, selected: p.type === layer.provider }, p.label)));
      return h('tr', null,
        h('td', null, h('b', null, layer.label), h('br'), h('small', { class: 'muted' }, layer.purpose)),
        h('td', null, select),
        h('td', null, layer.location, h('br'), h('small', { class: 'muted' }, layer.persistent ? 'survives restarts' : 'volatile')),
        h('td', null, act('Apply', () => api('PUT', '/memory/storage', { [id]: { provider: select.value } }).then((r) => {
          memStatus(r.changes.length ? r.changes.map((c) => `${c.layer}: ${c.from} → ${c.to}, ${c.copied} value(s) copied`).join('; ') : 'No change.');
          return r;
        }))));
    });
    const retention = h('input', { class: 'input', type: 'number', min: 2, max: 500, value: data.shortTermMaxMessages, style: 'max-width:100px' });
    return [
      h('p', { class: 'muted' }, 'Each layer has its own storage provider. Switching copies the layer\'s data into the new provider; nothing is deleted. SQLite, PostgreSQL or Redis plug in as providers without changing the memory manager.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Layer'), h('th', null, 'Provider'), h('th', null, 'Location'), h('th', null, ''))),
        h('tbody', null, rows))),
      h('div', { class: 'section-title' }, 'Short-term retention'),
      h('div', { class: 'row' }, retention, h('span', { class: 'muted' }, 'messages kept'),
        act('Apply', () => api('PUT', '/memory/storage', { shortTermMaxMessages: Number(retention.value) }))),
      h('p', { class: 'muted' }, `Configuration file: ${data.location}. Profile, invariants, tasks and the chat history are always JSON files (data/profile/, data/invariants/, data/tasks/, data/history/).`),
    ];
  }

  async function tabTasks() {
    const data = await api('GET', '/tasks');
    if (!data.tasks.length) return h('p', { class: 'muted' }, 'No tasks yet.');
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Task'), h('th', null, 'State'), h('th', null, 'Next'), h('th', null, 'Mode'), h('th', null, 'Created'), h('th', null, ''))),
      h('tbody', null, data.tasks.map((t) => h('tr', null,
        h('td', null, h('b', null, t.title), h('br'), h('small', { class: 'mono muted' }, t.id), t.id === data.activeTaskId ? h('span', { class: 'pill pill--accent' }, 'active') : ''),
        h('td', null, `${t.state}${t.awaitingInput ? ` · ${t.awaitingInput.reason}` : ''}`),
        h('td', null, t.nextState || 'none'),
        h('td', null, t.mode),
        h('td', null, fmtDateTime(t.createdAt)),
        h('td', null, h('span', { class: 'item-actions' },
          t.id !== data.activeTaskId ? act('Open', async () => {
            const r = await api('POST', `/tasks/${t.id}/activate`);
            applyResult(r);
            return r;
          }) : '',
          act('Delete', async () => {
            const r = await api('DELETE', `/tasks/${t.id}`);
            applyResult(r);
            return r;
          }, 'button--danger-ghost'))))))));
  }

  async function tabContext() {
    const data = await api('POST', '/token-counts', { message: input.value, includeText: true });
    applyTokens(data.tokens);
    const b = data.tokens.breakdown;
    const labels = {
      system: 'System instructions', profile: 'User profile', invariants: 'Active invariants', task: 'Current task',
      work: 'Work memory', longTerm: 'Relevant long-term memory', shortTerm: 'Short-term memory', taskState: 'Task state', request: 'Current request',
    };
    const order = data.order.map((k) => [k, labels[k] || k]);
    return [
      h('p', { class: 'muted' }, `The exact context the next "ask" would send (built by the ContextBuilder, with your current draft). Total: ${fmtNum(b.total)} tokens (${data.tokens.exact ? 'DeepSeek tokenizer' : 'estimated'}). Target: ${data.tokens.target.newTask ? 'a new task' : `task ${shortId(data.tokens.target.taskId)}`}, state ${data.tokens.target.state}.`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Section'), h('th', null, 'Tokens'))),
        h('tbody', null, order.map(([k, label]) => h('tr', null, h('td', null, label), h('td', null, fmtNum(b[k])))),
          h('tr', null, h('td', null, h('b', null, 'Whole request (with chat-template markers)')), h('td', null, h('b', null, fmtNum(b.total))))))),
      ...data.messages.map((m, i) => h('details', { class: 'preview', open: i === data.messages.length - 1 },
        h('summary', null, `${i + 1}. ${m.role} (${m.content.length} chars)`), h('pre', null, m.content))),
    ];
  }

  function rememberLongTerm(longTerm) {
    if (!longTerm) return;
    state.longTermContents = new Set([...(longTerm.solutions || []), ...(longTerm.knowledge || [])].map((e) => e.content.trim().toLowerCase()));
  }
  async function refreshLongTerm() {
    try {
      rememberLongTerm(await api('GET', '/memory/long-term'));
    } catch { /* Not essential. */ }
  }

  // --- Dialog plumbing ------------------------------------------------------------------

  $$('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    });
  });
  $('#auth-form').addEventListener('submit', () => {
    storageSet('deepseek-agent-token', $('#auth-token').value || null);
    init();
  });

  // --- Startup ----------------------------------------------------------------------

  async function init() {
    state.selectedMode = storageGet('deepseek-agent-mode') === 'auto' ? 'auto' : 'manual';
    try {
      const config = await api('GET', '/config');
      state.config = config;
      $('#health-dot').className = 'brand__dot is-ok';
      $('#model-badge').textContent = config.llm.model;
      const tk = $('#tokenizer-badge');
      tk.hidden = false;
      tk.textContent = config.tokenizer.exact ? 'exact token counts' : 'estimated token counts';
      const banner = $('#config-banner');
      banner.hidden = config.llm.apiKeyConfigured;
      banner.textContent = 'DEEPSEEK_API_KEY is not configured on the server. The UI works, but questions will fail until it is set (/etc/deepseek-app.env in production, .env locally).';
    } catch (err) {
      $('#health-dot').className = 'brand__dot is-bad';
      showError(err);
      return;
    }
    try {
      const [conv, profile] = await Promise.all([api('GET', '/history'), api('GET', '/profile'), loadInvariants(), refreshLongTerm()]);
      state.messages = conv.messages;
      applyTask(conv.task);
      applyTokens(conv.tokens);
      renderProfileView(profile);
      if (conv.busy) setBusy(true);
      renderChat();
      if (conv.busy) {
        // A request from another tab/reload is still running: follow it until it ends.
        const wait = setInterval(async () => {
          const d = await api('GET', '/tasks/active').catch(() => null);
          if (d && !d.busy) {
            clearInterval(wait);
            setBusy(false);
            const fresh = await api('GET', '/history');
            state.messages = fresh.messages;
            applyTask(fresh.task);
            applyTokens(fresh.tokens);
            renderChat();
          }
        }, 1500);
      }
    } catch (err) {
      showError(err);
    }
    autosize();
    input.focus();
  }

  init();
})();
