/*
 * DeepSeek Agent — browser client.
 *
 * Talks only to this server's /api. Everything is updated in place: no page
 * reloads. User-provided and model-provided text is inserted with textContent,
 * except agent answers, which go through the escaping Markdown renderer.
 */
(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const state = {
    config: null,
    task: null,
    busy: false,
    messageIds: new Set(),
    lastUsage: null,
    selectedMode: 'manual',
    target: null,
    longTermContents: new Set(),
    dismissed: new Set(),
    pollTimer: null,
    pollKick: null,
    previewTimer: null,
    previewSeq: 0,
    memoryTab: 'storage',
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
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const shortId = (id) => (id ? id.slice(0, 8) : '—');

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch { /* Private mode: the token is simply not remembered. */ }
  }

  // --- API -------------------------------------------------------------------------

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
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.status === 401) {
      askForToken();
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

  function askForToken() {
    const dialog = $('#auth-dialog');
    if (!dialog.open) dialog.showModal();
  }

  // --- Chat ------------------------------------------------------------------------

  const chatEl = $('#chat');
  const messagesEl = $('#messages');

  function nearBottom() {
    return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
  }
  function scrollToBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function stateBlock(task) {
    if (!task) return null;
    return h('div', { class: 'bubble__state' },
      h('span', null, 'Current state: ', h('b', null, task.currentState || '—')),
      h('span', null, 'Next state: ', h('b', null, task.nextState || '—')),
      h('span', null, 'Planned action: ', task.plannedAction || '—'));
  }

  function proposalBlock(message) {
    const items = (message.proposals || []).filter((p) => !state.dismissed.has(`${message.id}:${p.content}`));
    if (!items.length) return null;
    return h('div', { class: 'proposals' }, items.map((p) => {
      const saved = state.longTermContents.has(p.content.trim().toLowerCase());
      const row = h('div', { class: 'proposal' },
        h('span', { class: 'proposal__text' }, h('span', { class: 'proposal__cat' }, `Suggested for long-term · ${p.category}`), h('br'), p.content));
      if (saved) {
        row.append(h('span', { class: 'muted' }, 'saved ✓'));
      } else {
        row.append(
          h('button', {
            type: 'button', class: 'button button--small button--primary',
            onclick: async (event) => {
              event.target.disabled = true;
              try {
                const data = await api('POST', '/memory/long-term', { category: p.category, content: p.content, source: 'proposal' });
                rememberLongTerm(data.memory);
                applyTokens(data.summary);
                row.replaceWith(proposalBlockRow(p, 'saved ✓'));
              } catch (err) {
                event.target.disabled = false;
                showError(err);
              }
            },
          }, 'Save'),
          h('button', {
            type: 'button', class: 'button button--small button--ghost',
            onclick: () => { state.dismissed.add(`${message.id}:${p.content}`); row.remove(); },
          }, 'Dismiss'),
        );
      }
      return row;
    }));
  }

  function proposalBlockRow(p, note) {
    return h('div', { class: 'proposal' },
      h('span', { class: 'proposal__text' }, h('span', { class: 'proposal__cat' }, `Long-term · ${p.category}`), h('br'), p.content),
      h('span', { class: 'muted' }, note));
  }

  function renderMessage(m) {
    const isUser = m.role === 'user';
    const isStatus = m.kind === 'status';
    const body = h('div', { class: 'bubble__body' });
    if (isUser) body.textContent = m.content;
    else body.innerHTML = window.Markdown.render(m.content);

    const bubble = h('article', {
      class: `bubble ${isUser ? 'bubble--user' : 'bubble--agent'}${isStatus ? ' bubble--status' : ''}`,
      dataset: { id: m.id },
    },
    h('header', { class: 'bubble__head' },
      h('span', { class: 'bubble__tag' }, isUser ? 'you asked' : 'agent answered'),
      h('time', { class: 'bubble__time', datetime: m.timestamp }, fmtDateTime(m.timestamp))),
    body);

    if (!isUser) {
      bubble.append(stateBlock(m.task) || '');
      const meta = [];
      if (m.task?.performedState) meta.push(`step: ${m.task.performedState}`);
      if (m.task?.mode) meta.push(`${m.task.mode} mode`);
      if (m.usage?.contextTokens != null) {
        meta.push(`context ${fmtNum(m.usage.contextTokens)} tokens${m.usage.contextTokensExact ? '' : ' (estimate)'}`);
      }
      if (m.usage?.promptTokens != null) meta.push(`DeepSeek reported ${fmtNum(m.usage.promptTokens)} prompt tokens`);
      if (meta.length || m.task?.validation) {
        const metaEl = h('div', { class: 'bubble__meta' }, meta.join(' · '));
        if (m.task?.validation) {
          metaEl.append(h('span', { class: `verdict ${m.task.validation.passed ? 'verdict--pass' : 'verdict--fail'}` },
            m.task.validation.passed ? 'validation passed' : 'validation failed'));
        }
        bubble.append(metaEl);
      }
      const proposals = proposalBlock(m);
      if (proposals) bubble.append(proposals);
    }
    return bubble;
  }

  /** Add messages that are not on screen yet, in order. */
  function appendMessages(list, { forceScroll = false } = {}) {
    const stick = forceScroll || nearBottom();
    let added = false;
    for (const m of list || []) {
      if (!m?.id || state.messageIds.has(m.id)) continue;
      if (m.role === 'user') $('#pending-user')?.remove();
      state.messageIds.add(m.id);
      const pending = $('#pending-agent');
      if (pending) messagesEl.insertBefore(renderMessage(m), pending);
      else messagesEl.append(renderMessage(m));
      added = true;
    }
    updateEmpty();
    if (added && stick) scrollToBottom();
  }

  function replaceMessages(list) {
    messagesEl.replaceChildren();
    state.messageIds.clear();
    appendMessages(list, { forceScroll: true });
  }

  function updateEmpty() {
    $('#empty').hidden = messagesEl.children.length > 0;
  }

  function showPending(userText, label) {
    removePending();
    if (userText) {
      messagesEl.append(h('article', { class: 'bubble bubble--user', id: 'pending-user' },
        h('header', { class: 'bubble__head' },
          h('span', { class: 'bubble__tag' }, 'you asked'),
          h('time', { class: 'bubble__time' }, fmtDateTime(new Date().toISOString()))),
        h('div', { class: 'bubble__body' }, userText)));
    }
    messagesEl.append(h('article', { class: 'bubble bubble--agent bubble--pending', id: 'pending-agent', 'aria-busy': 'true' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { id: 'pending-label' }, label)));
    updateEmpty();
    scrollToBottom();
  }

  function removePending() {
    $('#pending-user')?.remove();
    $('#pending-agent')?.remove();
    updateEmpty();
  }

  function rerenderProposals() {
    // Refresh "saved ✓" markers after long-term memory changed elsewhere.
    for (const bubble of $$('.bubble--agent[data-id]')) {
      bubble.querySelector('.proposals')?.remove();
    }
    api('GET', '/chat/history').then((data) => {
      const byId = new Map(data.messages.map((m) => [m.id, m]));
      for (const bubble of $$('.bubble--agent[data-id]')) {
        const m = byId.get(bubble.dataset.id);
        const block = m && proposalBlock(m);
        if (block) bubble.append(block);
      }
    }).catch(() => {});
  }

  // --- Task panel -----------------------------------------------------------------

  function renderTask(task) {
    state.task = task;
    const busyHere = state.busy;
    $('#task-id').textContent = task ? task.id : '—';
    $('#task-id').title = task ? `${task.title}\n${task.id}` : '';
    const currentLabel = !task ? '—'
      : task.currentState === 'paused' ? `paused (in ${task.resumeState})`
        : task.currentState === 'error' ? `error (in ${task.resumeState})` : task.currentState;
    $('#task-current').textContent = currentLabel;
    $('#task-next').textContent = task ? (task.nextState || '—') : '—';
    const statusEl = $('#task-status');
    statusEl.textContent = task ? `${task.status}${task.pauseRequested ? ' (pause requested)' : ''}` : 'no task';
    statusEl.className = task ? `status status--${task.status}` : '';
    $('#task-action').textContent = task ? task.plannedAction : 'Ask a question to start a task.';

    const errorEl = $('#task-error');
    errorEl.hidden = !(task && task.status === 'failed' && task.lastError);
    errorEl.textContent = task?.lastError ? `Last step failed: ${task.lastError}` : '';

    // Stepper
    const order = ['planning', 'execution', 'validation', 'done'];
    const effective = !task ? null : (task.currentState === 'paused' || task.currentState === 'error') ? task.resumeState : task.currentState;
    const idx = order.indexOf(effective);
    const stepper = $('#stepper');
    stepper.classList.toggle('is-paused', task?.status === 'paused');
    stepper.classList.toggle('is-failed', task?.status === 'failed');
    for (const li of $$('li', stepper)) {
      const i = order.indexOf(li.dataset.state);
      li.className = '';
      if (!task) continue;
      if (i === idx) li.classList.add(task.status === 'completed' ? 'is-past' : 'is-current');
      else if (i < idx) li.classList.add('is-past');
      if (task.nextState === li.dataset.state && task.status !== 'completed') li.classList.add('is-next');
    }

    // Mode
    if (task && task.status !== 'completed') state.selectedMode = task.mode;
    for (const button of $$('.segmented button')) {
      button.setAttribute('aria-checked', String(button.dataset.mode === state.selectedMode));
      button.disabled = busyHere && !!task;
    }

    // Controls
    const cont = $('#btn-continue');
    const pause = $('#btn-pause');
    const status = task?.status;
    cont.disabled = busyHere || !(status === 'waiting' || status === 'failed');
    cont.textContent = status === 'failed' ? `retry ${task.nextState}`
      : status === 'waiting' && task.nextState ? `continue → ${task.nextState}` : 'continue';

    if (status === 'paused') {
      pause.textContent = 'resume';
      pause.disabled = busyHere;
    } else {
      pause.textContent = task?.pauseRequested ? 'pausing…' : 'pause';
      // While a request runs, pause is always offered: the panel may not have
      // seen the new task yet, so the click looks the running task up itself.
      pause.disabled = !(busyHere || status === 'waiting' || status === 'running') || Boolean(task?.pauseRequested);
    }
    $('#btn-new-task').disabled = busyHere || !task;
  }

  function applyTokens(tokens) {
    if (!tokens) return;
    $('#tok-short').textContent = fmtNum(tokens.shortTerm);
    $('#tok-work').textContent = fmtNum(tokens.workMemory);
    $('#tok-long').textContent = fmtNum(tokens.longTerm);
    $('#tok-context').textContent = fmtNum(tokens.currentRequestContext);
    const method = $('#tok-method');
    method.textContent = tokens.exact ? 'exact' : '≈ estimate';
    method.title = state.config?.tokenizer?.note || '';
    if (tokens.target) {
      state.target = tokens.target;
      updateRouteHint();
    }
  }

  function applyUsage(usage) {
    if (!usage) return;
    state.lastUsage = usage;
    const el = $('#last-usage');
    el.hidden = false;
    el.textContent = `Last request sent: ${fmtNum(usage.contextTokens)} tokens counted${usage.contextTokensExact ? '' : ' (estimate)'}`
      + (usage.promptTokens != null ? ` · DeepSeek reported ${fmtNum(usage.promptTokens)} prompt + ${fmtNum(usage.completionTokens)} completion tokens` : '');
  }

  function updateRouteHint() {
    const t = state.target;
    const hint = $('#route-hint');
    if (state.busy) {
      hint.textContent = 'The agent is working…';
    } else if (!t || t.newTask) {
      hint.textContent = `Your question starts a new task (${state.selectedMode} mode).`;
    } else if (t.blocked === 'paused') {
      hint.textContent = 'The task is paused. Resume it, or start a new task.';
    } else if (t.blocked === 'running') {
      hint.textContent = 'The agent is working on this task.';
    } else {
      hint.textContent = `Your question goes to task ${shortId(t.taskId)} and runs its ${t.state} state.`;
    }
    updateAskButton();
  }

  function updateAskButton() {
    const text = $('#question').value.trim();
    const blocked = state.target?.blocked;
    $('#btn-ask').disabled = state.busy || !text || Boolean(blocked);
  }

  // --- Errors --------------------------------------------------------------------------

  function showError(err) {
    const el = $('#error');
    el.textContent = err.message + (err.code && !['http_error', 'network'].includes(err.code) ? ` (${err.code})` : '');
    el.hidden = false;
  }
  function clearError() {
    $('#error').hidden = true;
  }

  /** Apply whatever the server attached to a failure (saved messages, the failed task). */
  function applyFailure(err) {
    const result = err.data?.result;
    if (!result) return false;
    appendMessages(result.messages);
    renderTask(result.task);
    applyTokens(result.tokens);
    return result.messages?.some((m) => m.role === 'user') ?? false;
  }

  // --- Operations ------------------------------------------------------------------------

  async function runOperation(label, userText, fn) {
    if (state.busy) return;
    state.busy = true;
    clearError();
    renderTask(state.task);
    updateRouteHint();
    showPending(userText, label);
    startPolling();
    try {
      const result = await fn();
      removePending();
      appendMessages(result.messages, { forceScroll: true });
      renderTask(result.task);
      applyTokens(result.tokens);
      applyUsage(result.usage);
      if (result.memoryUpdates?.length) {
        showNote(result.memoryUpdates.map((u) => (u.layer === 'longTerm'
          ? `${u.created ? 'Saved' : 'Already in'} long-term memory (${u.category}): ${u.content}`
          : `Added to work memory (${u.field}): ${u.content}`)).join('\n'));
        refreshLongTermSet();
      }
      return result;
    } catch (err) {
      removePending();
      err.saved = applyFailure(err);
      showError(err);
      throw err;
    } finally {
      stopPolling();
      state.busy = false;
      renderTask(state.task);
      updateRouteHint();
      schedulePreview();
    }
  }

  function showNote(text) {
    const note = h('article', { class: 'bubble bubble--status bubble--note' }, h('div', { class: 'bubble__body' }, text));
    messagesEl.append(note);
    scrollToBottom();
  }

  async function ask(event) {
    event?.preventDefault();
    const input = $('#question');
    const text = input.value.trim();
    if (!text || state.busy) return;
    const max = state.config?.limits?.maxMessageChars ?? 8000;
    if (text.length > max) {
      showError(new ApiError(`The question is too long (${text.length} of ${max} characters).`, { code: 'invalid_input' }));
      return;
    }
    input.value = '';
    autoGrow();
    const label = state.target?.newTask !== false ? `Planning a new task (${state.selectedMode} mode)…` : `Working on ${state.target?.state}…`;
    try {
      await runOperation(label, text, () => api('POST', '/chat', { message: text, mode: state.selectedMode }));
    } catch (err) {
      // Not saved on the server (validation, busy, network): give the text back.
      if (!err.saved && !input.value) {
        input.value = text;
        autoGrow();
        updateAskButton();
      }
    }
    input.focus();
  }

  function taskAction(action) {
    if (action === 'pause') {
      pauseTask();
      return;
    }
    const task = state.task;
    if (!task) return;
    if (action === 'continue') {
      const label = task.status === 'failed' ? `Retrying ${task.nextState}…` : `Running ${task.nextState}…`;
      runOperation(label, null, () => api('POST', `/tasks/${task.id}/continue`)).catch(() => {});
    } else if (action === 'resume') {
      runOperation(task.mode === 'auto' ? 'Resuming in auto mode…' : 'Resuming…', null,
        () => api('POST', `/tasks/${task.id}/resume`)).catch(() => {});
    }
  }

  /** Allowed while busy: the pause then lands after the running step. */
  async function pauseTask() {
    try {
      const target = state.busy ? (await api('GET', '/tasks/active')).task : state.task;
      if (!target) return;
      const data = await api('POST', `/tasks/${target.id}/pause`);
      renderTask(data.task);
      const label = $('#pending-label');
      if (state.busy && label) label.textContent = 'Pausing after the current step…';
    } catch (err) {
      showError(err);
    }
  }

  async function setMode(mode) {
    state.selectedMode = mode;
    const task = state.task;
    if (task && task.status !== 'completed' && !state.busy) {
      try {
        const data = await api('POST', `/tasks/${task.id}/${mode}`);
        renderTask(data.task);
        applyTokens(data.tokens);
      } catch (err) {
        showError(err);
      }
    } else {
      renderTask(task);
    }
    updateRouteHint();
  }

  async function newTask() {
    try {
      const data = await api('DELETE', '/tasks/active');
      renderTask(null);
      applyTokens(data.tokens);
      showNote('The next question starts a new task. Earlier tasks stay available under Tasks.');
    } catch (err) {
      showError(err);
    }
  }

  // --- Polling during long operations ---------------------------------------------------

  function startPolling() {
    stopPolling();
    // First poll almost at once, so the panel shows the running task (and
    // enables pause) right after the server has created or started it.
    state.pollKick = setTimeout(poll, 250);
    state.pollTimer = setInterval(poll, 1000);

    async function poll() {
      try {
        const data = await api('GET', '/chat/history');
        if (!state.busy) return;
        appendMessages(data.messages);
        if (data.task) {
          renderTask(data.task);
          const label = $('#pending-label');
          if (label && data.task.status === 'running' && !data.task.pauseRequested) {
            label.textContent = `Working: ${data.task.currentState} (${data.task.mode} mode)…`;
          }
        }
        applyTokens(data.tokens);
      } catch { /* The main request reports errors. */ }
    }
  }
  function stopPolling() {
    clearTimeout(state.pollKick);
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // --- Live token preview of the next request ----------------------------------------------

  function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(async () => {
      const seq = ++state.previewSeq;
      try {
        const data = await api('POST', '/context/preview', { message: $('#question').value.slice(0, 8000) });
        if (seq === state.previewSeq) applyTokens(data.tokens);
      } catch { /* Counting failures must not disturb typing. */ }
    }, 300);
  }

  function autoGrow() {
    const input = $('#question');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  // --- Profile modal ------------------------------------------------------------------------

  const SUGGESTIONS = {
    style: ['concise', 'detailed', 'technical', 'friendly'],
    format: ['markdown', 'plain text', 'structured', 'bullet points'],
    limitations: ['maximum 200 words', 'no code unless asked', 'avoid marketing language'],
  };

  let profileData = null;

  function profileStatus(text, isError = false) {
    const el = $('#profile-status');
    el.textContent = text;
    el.classList.toggle('modal__status--error', isError);
  }

  function renderProfile(data) {
    profileData = data;
    const fields = $('#profile-fields');
    fields.replaceChildren();
    for (const [name, spec] of Object.entries(data.fields)) {
      const id = `profile-${name}`;
      const textarea = h('textarea', { id, name, rows: 2, maxlength: spec.max, oninput: updateProfilePreview });
      textarea.value = data.profile?.[name] ?? '';
      const chips = h('div', { class: 'chips' }, (SUGGESTIONS[name] || []).map((word) => h('button', {
        type: 'button', class: 'chip',
        onclick: () => {
          const current = textarea.value.trim();
          if (!current.toLowerCase().split(/,\s*/).includes(word)) textarea.value = current ? `${current}, ${word}` : word;
          updateProfilePreview();
          textarea.focus();
        },
      }, `+ ${word}`)));
      fields.append(h('div', { class: 'field' },
        h('label', { class: 'field__label', for: id }, spec.label),
        h('span', { class: 'field__hint' }, spec.hint), textarea, chips));
    }
    $('#profile-state').textContent = data.exists
      ? `Profile saved ${fmtDateTime(data.profile.updatedAt)}${data.applied ? ' and applied to every request.' : ' but empty: nothing is added to requests.'}`
      : 'No profile yet. Fill in the fields and save to create it.';
    $('#profile-delete').disabled = !data.exists;
    $('#profile-clear').disabled = !data.exists;
    $('#profile-save').textContent = data.exists ? 'Save profile' : 'Create profile';
    $('#profile-dot').hidden = !data.applied;
    $('#profile-confirm').hidden = true;
    $('#profile-preview').textContent = data.contextText ? `[USER PROFILE]\n${data.contextText}` : '[USER PROFILE]\n(empty section)';
    $('#profile-tokens').textContent = fmtNum(data.tokens?.breakdown?.profile ?? 0);
    applyTokens(data.tokens);
  }

  function updateProfilePreview() {
    if (!profileData) return;
    const lines = Object.entries(profileData.fields)
      .map(([name, spec]) => [spec.label, $(`#profile-${name}`).value.trim()])
      .filter(([, v]) => v)
      .map(([label, v]) => `${label}: ${v}`);
    $('#profile-preview').textContent = `[USER PROFILE]\n${lines.join('\n') || '(empty section)'}`;
    profileStatus('Unsaved changes');
  }

  async function openProfile() {
    const dialog = $('#profile-dialog');
    profileStatus('Loading…');
    dialog.showModal();
    try {
      renderProfile(await api('GET', '/profile'));
      profileStatus('');
    } catch (err) {
      profileStatus(err.message, true);
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    const body = {};
    for (const name of Object.keys(profileData?.fields || {})) body[name] = $(`#profile-${name}`).value;
    profileStatus('Saving…');
    try {
      const data = await api('PUT', '/profile', body);
      renderProfile(data);
      profileStatus('Saved. The next request uses this profile.');
      schedulePreview();
    } catch (err) {
      profileStatus(err.message, true);
    }
  }

  async function clearProfile() {
    profileStatus('Clearing…');
    try {
      renderProfile(await api('POST', '/profile/clear'));
      profileStatus('Cleared. Requests no longer include profile text.');
      schedulePreview();
    } catch (err) {
      profileStatus(err.message, true);
    }
  }

  async function deleteProfile() {
    profileStatus('Deleting…');
    try {
      renderProfile(await api('DELETE', '/profile'));
      profileStatus('Profile deleted.');
      schedulePreview();
    } catch (err) {
      profileStatus(err.message, true);
    }
  }

  // --- Memory modal ------------------------------------------------------------------------------

  function memoryStatus(text, isError = false) {
    const el = $('#memory-status');
    el.textContent = text;
    el.classList.toggle('modal__status--error', isError);
  }

  function openMemory(tab) {
    const dialog = $('#memory-dialog');
    if (!dialog.open) dialog.showModal();
    selectTab(tab || state.memoryTab);
  }

  function selectTab(tab) {
    state.memoryTab = tab;
    for (const b of $$('.tabs [role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    memoryStatus('Loading…');
    const body = $('#memory-body');
    body.replaceChildren();
    const renderers = { storage: tabStorage, short: tabShort, work: tabWork, long: tabLong, tasks: tabTasks, context: tabContext };
    renderers[tab](body)
      .then(() => memoryStatus(''))
      .catch((err) => memoryStatus(err.message, true));
  }

  function inlineConfirm(anchor, text, yesLabel, onYes) {
    anchor.parentElement.querySelector('.confirm')?.remove();
    const box = h('div', { class: 'confirm' }, h('span', null, text),
      h('button', { type: 'button', class: 'button button--danger button--small', onclick: () => { box.remove(); onYes(); } }, yesLabel),
      h('button', { type: 'button', class: 'button button--ghost button--small', onclick: () => box.remove() }, 'Cancel'));
    anchor.after(box);
  }

  async function guarded(label, fn) {
    memoryStatus(label);
    try {
      await fn();
    } catch (err) {
      memoryStatus(err.message, true);
    }
  }

  async function tabStorage(body) {
    const { storage } = await api('GET', '/memory/storage');
    const form = h('form', { novalidate: true });
    for (const [id, layer] of Object.entries(storage.layers)) {
      const select = h('select', { name: `${id}-backend`, 'aria-label': `${layer.label} storage` },
        storage.backends.map((b) => h('option', { value: b.type, selected: b.type === layer.backend }, b.label)));
      const optionsBox = h('div', { class: 'row' });
      const renderOptions = () => {
        optionsBox.replaceChildren();
        const backend = storage.backends.find((b) => b.type === select.value);
        for (const [name, spec] of Object.entries(backend.options || {})) {
          const checked = select.value === layer.backend ? layer.options[name] : spec.default;
          optionsBox.append(h('label', null, h('input', { type: 'checkbox', name: `${id}-opt-${name}`, checked }), spec.label));
        }
        const desc = backend.description;
        optionsBox.append(h('span', { class: 'muted' }, desc));
      };
      select.addEventListener('change', renderOptions);
      renderOptions();
      form.append(h('section', { class: 'card' },
        h('div', { class: 'card__head' },
          h('h3', { class: 'card__title' }, layer.label),
          h('span', { class: `badge ${layer.persistent ? 'badge--ok' : 'badge--warn'}` },
            `${storage.backends.find((b) => b.type === layer.backend)?.label} · ${layer.location}`)),
        h('p', { class: 'card__sub' }, layer.purpose),
        h('div', { class: 'row' }, h('label', null, 'Storage ', select)),
        optionsBox,
        id === 'shortTerm' ? h('div', { class: 'row' }, h('label', null, 'Keep the last ',
          h('input', { type: 'number', name: 'maxMessages', min: 2, max: 500, step: 1, value: storage.shortTerm.maxMessages, class: 'input input--narrow' }),
          ' messages')) : null));
    }
    form.append(h('section', { class: 'card' },
      h('h3', { class: 'card__title' }, 'Fixed stores'),
      h('dl', { class: 'kv' }, Object.values(storage.fixed).flatMap((f) => [h('dt', null, f.label), h('dd', null, `JSON file · ${f.location}`)]))));
    const result = h('div');
    form.append(h('div', { class: 'row' }, h('button', { type: 'submit', class: 'button button--primary' }, 'Save storage configuration')), result);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const layers = {};
      for (const id of Object.keys(storage.layers)) {
        const backendType = fd.get(`${id}-backend`);
        const backend = storage.backends.find((b) => b.type === backendType);
        const options = {};
        for (const name of Object.keys(backend.options || {})) options[name] = fd.get(`${id}-opt-${name}`) === 'on';
        layers[id] = { backend: backendType, options };
      }
      const maxMessages = Number(fd.get('maxMessages'));
      guarded('Saving…', async () => {
        const data = await api('PUT', '/memory/storage', { layers, shortTerm: { maxMessages } });
        applyTokens(data.tokens);
        body.replaceChildren();
        await tabStorage(body);
        const notes = data.changes.map((c) => (c.retention ? `Short-term retention set to ${c.retention} messages.`
          : c.from === c.to ? `${c.layer}: options updated.`
            : `${c.layer}: ${c.from} → ${c.to}, ${c.copied} document(s) copied${c.backup ? `, previous files backed up to ${c.backup}` : ''}. Old data was left in place.`));
        memoryStatus(notes.length ? notes.join(' ') : 'Nothing changed.');
      });
    });
    body.append(form);
  }

  async function tabShort(body) {
    const data = await api('GET', '/memory/short-term');
    const clearBtn = h('button', {
      type: 'button', class: 'button button--danger-ghost',
      onclick: () => inlineConfirm(clearBtn, 'Clear the whole conversation?', 'Clear', () => guarded('Clearing…', async () => {
        const res = await api('DELETE', '/memory/short-term');
        replaceMessages([]);
        applyTokens(res.tokens);
        await selectTab('short');
      })),
    }, 'Clear short-term memory');
    body.append(
      h('p', { class: 'muted' }, `${data.messages.length} of at most ${data.maxMessages} messages · ${fmtNum(data.tokens)} tokens. Status notes are shown in the chat but not sent to DeepSeek.`),
      h('div', { class: 'row' }, clearBtn),
      h('ul', { class: 'list' }, data.messages.slice().reverse().map((m) => h('li', null,
        h('div', null, h('b', null, m.role === 'user' ? 'you asked' : 'agent answered'), ` · ${fmtDateTime(m.timestamp)}${m.kind === 'status' ? ' · status' : ''}`,
          h('br'), m.content.length > 300 ? `${m.content.slice(0, 300)}…` : m.content),
        h('div', { class: 'actions' }, h('button', {
          type: 'button', class: 'button button--small button--danger-ghost',
          onclick: () => guarded('Deleting…', async () => {
            const res = await api('DELETE', `/memory/short-term/${m.id}`);
            applyTokens(res.tokens);
            $(`.bubble[data-id="${m.id}"]`)?.remove();
            state.messageIds.delete(m.id);
            updateEmpty();
            await selectTab('short');
          }),
        }, 'Delete'))))),
    );
  }

  async function tabWork(body) {
    const data = await api('GET', '/memory/work');
    if (!data.workMemory) {
      body.append(h('p', { class: 'muted' }, 'There is no active task, so there is no work memory to show. Open a task under Tasks.'));
      return;
    }
    const w = data.workMemory;
    const lines = (list) => list.join('\n');
    const field = (name, label, value, rows = 3, hint) => h('div', { class: 'field' },
      h('label', { class: 'field__label', for: `work-${name}` }, label),
      hint ? h('span', { class: 'field__hint' }, hint) : null,
      h('textarea', { id: `work-${name}`, name, rows }, value));
    const form = h('form', { novalidate: true },
      h('p', { class: 'muted' }, `Task ${data.taskId} · ${fmtNum(data.tokens)} tokens · updated ${fmtDateTime(w.updatedAt)}`),
      field('objective', 'Objective', w.objective, 2),
      field('plan', 'Plan', lines(w.plan), 4, 'One step per line.'),
      field('requirements', 'Requirements', lines(w.requirements), 3, 'One per line.'),
      field('decisions', 'Decisions', lines(w.decisions), 3, 'One per line.'),
      field('facts', 'Facts', lines(w.facts), 3, 'One per line.'),
      field('variables', 'Variables', Object.entries(w.variables).map(([k, v]) => `${k} = ${v}`).join('\n'), 2, 'name = value, one per line.'),
      h('h3', { class: 'section' }, 'Intermediate results (recorded by the agent)'),
      resultList(w.intermediateResults),
      h('h3', { class: 'section' }, 'Validation results'),
      resultList(w.validationResults));
    const clearBtn = h('button', { type: 'button', class: 'button button--danger-ghost' }, 'Clear work memory');
    clearBtn.addEventListener('click', () => inlineConfirm(clearBtn, 'Clear all work memory of this task?', 'Clear', () => guarded('Clearing…', async () => {
      const res = await api('DELETE', `/memory/work/${data.taskId}`);
      applyTokens(res.summary);
      await selectTab('work');
    })));
    form.append(h('div', { class: 'row' }, h('button', { type: 'submit', class: 'button button--primary' }, 'Save work memory'), clearBtn));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const split = (name) => $(`#work-${name}`).value.split('\n').map((s) => s.trim()).filter(Boolean);
      const variables = {};
      for (const line of split('variables')) {
        const i = line.indexOf('=');
        if (i > 0) variables[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      guarded('Saving…', async () => {
        const res = await api('PUT', `/memory/work/${data.taskId}`, {
          objective: $('#work-objective').value, plan: split('plan'), requirements: split('requirements'),
          decisions: split('decisions'), facts: split('facts'), variables,
        });
        applyTokens(res.summary);
        await selectTab('work');
        memoryStatus('Work memory saved.');
      });
    });
    body.append(form);
  }

  function resultList(items) {
    if (!items.length) return h('p', { class: 'muted' }, 'None yet.');
    return h('ul', { class: 'list' }, items.slice().reverse().map((r) => h('li', null, h('div', null,
      h('b', null, `[${r.state ?? 'note'}]`),
      typeof r.passed === 'boolean' ? h('span', { class: `verdict ${r.passed ? 'verdict--pass' : 'verdict--fail'}` }, r.passed ? 'passed' : 'failed') : null,
      ` ${fmtDateTime(r.timestamp)}`, h('br'), r.text))));
  }

  function rememberLongTerm(memory) {
    state.longTermContents = new Set(Object.values(memory || {}).flat().map((i) => i.content.trim().toLowerCase()));
  }

  async function refreshLongTermSet() {
    try {
      const data = await api('GET', '/memory/long-term');
      rememberLongTerm(data.memory);
    } catch { /* Only affects the "saved" markers. */ }
  }

  async function tabLong(body, query = '') {
    const data = await api('GET', '/memory/long-term');
    rememberLongTerm(data.memory);
    const categories = data.categories;

    const addForm = h('form', { class: 'card', novalidate: true },
      h('h3', { class: 'card__title' }, 'Save an entry'),
      h('div', { class: 'row' },
        h('label', null, 'Category ', h('select', { name: 'category' }, Object.entries(categories).map(([v, l]) => h('option', { value: v }, l)))),
        h('label', null, 'Tags ', h('input', { name: 'tags', class: 'input input--medium', placeholder: 'comma separated' }))),
      h('div', { class: 'field' }, h('textarea', { name: 'content', rows: 2, maxlength: 2000, 'aria-label': 'Content', placeholder: 'What should the agent remember across tasks?' })),
      h('button', { type: 'submit', class: 'button button--primary' }, 'Save to long-term memory'));
    addForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const fd = new FormData(addForm);
      guarded('Saving…', async () => {
        const res = await api('POST', '/memory/long-term', {
          category: fd.get('category'),
          content: String(fd.get('content') || ''),
          tags: String(fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean),
        });
        applyTokens(res.summary);
        await selectTab('long');
        memoryStatus(res.created ? 'Saved.' : 'That entry already exists.');
        rerenderProposals();
      });
    });

    const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Search long-term memory', value: query, 'aria-label': 'Search' });
    const results = h('div');
    const runSearch = async () => {
      const q = searchInput.value.trim();
      results.replaceChildren();
      if (!q) return;
      const res = await api('GET', `/memory/long-term?q=${encodeURIComponent(q)}`);
      results.append(res.results.length
        ? h('ul', { class: 'list' }, res.results.map((r) => h('li', null, h('div', null, h('b', null, `${categories[r.category]} · score ${r.score}`), h('br'), r.content))))
        : h('p', { class: 'muted' }, 'No matches.'));
    };
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch().catch((err) => memoryStatus(err.message, true)); } });

    body.append(
      h('p', { class: 'muted' }, `${fmtNum(data.tokens)} tokens. Only entries you save (or approve) are kept here; conversations are never copied automatically.`),
      addForm,
      h('div', { class: 'card' }, h('div', { class: 'row' }, searchInput,
        h('button', { type: 'button', class: 'button', onclick: () => runSearch().catch((err) => memoryStatus(err.message, true)) }, 'Search')), results));

    for (const [category, label] of Object.entries(categories)) {
      const items = data.memory[category];
      const clearBtn = h('button', { type: 'button', class: 'button button--small button--danger-ghost', disabled: !items.length }, 'Clear');
      clearBtn.addEventListener('click', () => inlineConfirm(clearBtn, `Delete all ${label.toLowerCase()}?`, 'Clear', () => guarded('Clearing…', async () => {
        const res = await api('DELETE', `/memory/long-term?category=${category}`);
        applyTokens(res.summary);
        await selectTab('long');
        rerenderProposals();
      })));
      body.append(h('section', { class: 'card' },
        h('div', { class: 'card__head' }, h('h3', { class: 'card__title' }, `${label} (${items.length})`), clearBtn),
        items.length ? h('ul', { class: 'list' }, items.map((item) => longTermItem(item, categories))) : h('p', { class: 'muted' }, 'Empty.')));
    }
  }

  function longTermItem(item, categories) {
    const li = h('li');
    const view = () => {
      li.replaceChildren(
        h('div', null, item.content, h('br'), h('span', { class: 'muted' },
          `${item.tags.length ? `#${item.tags.join(' #')} · ` : ''}${item.source} · ${fmtDateTime(item.updatedAt)}`)),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'button button--small', onclick: edit }, 'Edit'),
          h('button', {
            type: 'button', class: 'button button--small button--danger-ghost',
            onclick: () => guarded('Deleting…', async () => {
              const res = await api('DELETE', `/memory/long-term/${item.id}`);
              applyTokens(res.summary);
              await selectTab('long');
              rerenderProposals();
            }),
          }, 'Delete')));
    };
    const edit = () => {
      const text = h('textarea', { rows: 3, maxlength: 2000, class: 'input', 'aria-label': 'Content' }, item.content);
      const tags = h('input', { class: 'input', value: item.tags.join(', '), 'aria-label': 'Tags' });
      const category = h('select', { 'aria-label': 'Category' }, Object.entries(categories).map(([v, l]) => h('option', { value: v, selected: v === item.category }, l)));
      li.replaceChildren(h('div', null, text, h('div', { class: 'row' }, category, tags)),
        h('div', { class: 'actions' },
          h('button', {
            type: 'button', class: 'button button--small button--primary',
            onclick: () => guarded('Saving…', async () => {
              const res = await api('PUT', `/memory/long-term/${item.id}`, {
                content: text.value, category: category.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
              });
              applyTokens(res.summary);
              await selectTab('long');
            }),
          }, 'Save'),
          h('button', { type: 'button', class: 'button button--small button--ghost', onclick: view }, 'Cancel')));
    };
    view();
    return li;
  }

  async function tabTasks(body) {
    const data = await api('GET', '/tasks');
    if (!data.tasks.length) {
      body.append(h('p', { class: 'muted' }, 'No tasks yet. Ask a question to start one.'));
      return;
    }
    body.append(h('p', { class: 'muted' }, `Default mode for new tasks: ${data.defaultMode}. Tasks and their work memory survive restarts.`));
    body.append(h('ul', { class: 'list' }, data.tasks.map((t) => {
      const active = t.id === data.activeTaskId;
      const del = h('button', { type: 'button', class: 'button button--small button--danger-ghost', disabled: t.busy }, 'Delete');
      del.addEventListener('click', () => inlineConfirm(del.parentElement, 'Delete this task and its work memory?', 'Delete', () => guarded('Deleting…', async () => {
        const res = await api('DELETE', `/tasks/${t.id}`);
        renderTask(res.task);
        applyTokens(res.tokens);
        await selectTab('tasks');
      })));
      return h('li', null,
        h('div', null, h('b', null, t.title), active ? h('span', { class: 'badge badge--ok badge--inline' }, 'active') : null, h('br'),
          h('span', { class: 'muted mono' }, t.id), h('br'),
          h('span', null, `${t.currentState}${t.resumeState ? ` (in ${t.resumeState})` : ''} → ${t.nextState ?? '—'} · `),
          h('span', { class: `status status--${t.status}` }, t.status),
          h('span', { class: 'muted' }, ` · ${t.mode} · ${t.transitions} transitions · created ${fmtDateTime(t.createdAt)}`)),
        h('div', { class: 'actions' },
          h('button', {
            type: 'button', class: 'button button--small', disabled: active,
            onclick: () => guarded('Opening…', async () => {
              const res = await api('POST', `/tasks/${t.id}/activate`);
              renderTask(res.task);
              applyTokens(res.tokens);
              await selectTab('tasks');
              memoryStatus('This task is now active.');
            }),
          }, 'Open'),
          del));
    })));
  }

  async function tabContext(body) {
    const data = await api('POST', '/context/preview', { message: $('#question').value.slice(0, 8000), includeText: true });
    const b = data.tokens.breakdown;
    const rows = [
      ['System instructions', b.system], ['User profile', b.profile], ['Long-term memory', b.longTerm],
      ['Work memory', b.work], ['Short-term memory (chat turns)', b.shortTerm], ['Current request', b.request],
    ];
    const target = data.tokens.target;
    body.append(
      h('p', { class: 'muted' }, `This is exactly what the next "ask" sends${target.newTask ? ' (as a new task)' : ` to task ${shortId(target.taskId)} in its ${target.state} state`}, using the text currently in the input. `
        + (data.tokens.exact ? 'Counts use DeepSeek\'s tokenizer.' : 'Counts are estimates.')),
      h('table', { class: 'breakdown' },
        rows.map(([label, n]) => h('tr', null, h('td', null, label), h('td', null, fmtNum(n)))),
        h('tr', { class: 'total' }, h('td', null, 'Complete request (incl. chat-template tokens)'), h('td', null, fmtNum(b.total)))),
      data.droppedTurns ? h('p', { class: 'notice' }, `${data.droppedTurns} old message(s) left out to stay within the context budget.`) : null,
      ...data.messages.map((m, i) => h('div', null,
        h('h3', { class: 'section' }, `${i + 1}. ${m.role}`),
        h('pre', { class: 'block' }, m.content))),
    );
    applyTokens(data.tokens);
  }

  // --- Startup -----------------------------------------------------------------------------------

  async function loadConfig() {
    const config = await api('GET', '/config');
    state.config = config;
    $('#model-badge').textContent = `${config.llm.provider} · ${config.llm.model}`;
    const tokBadge = $('#tokenizer-badge');
    tokBadge.hidden = false;
    tokBadge.textContent = config.tokenizer.exact ? 'exact token counts' : 'estimated token counts';
    tokBadge.className = `badge ${config.tokenizer.exact ? 'badge--ok' : 'badge--warn'}`;
    tokBadge.title = config.tokenizer.note;
    $('#question').maxLength = config.limits.maxMessageChars;
    const banner = $('#config-banner');
    banner.hidden = config.llm.apiKeyConfigured;
    banner.textContent = 'DEEPSEEK_API_KEY is not configured on the server. The interface works, but questions will fail until an administrator sets it.';
    $('#health-dot').className = `brand__dot ${config.llm.apiKeyConfigured ? 'brand__dot--ok' : 'brand__dot--bad'}`;
  }

  async function loadState() {
    const [history, tasks] = await Promise.all([api('GET', '/chat/history'), api('GET', '/tasks')]);
    await refreshLongTermSet();
    state.selectedMode = history.task && history.task.status !== 'completed' ? history.task.mode : tasks.defaultMode;
    replaceMessages(history.messages);
    renderTask(history.task);
    applyTokens(history.tokens);
    const lastUsage = history.messages.filter((m) => m.usage).at(-1)?.usage;
    applyUsage(lastUsage);
    api('GET', '/profile').then((p) => { $('#profile-dot').hidden = !p.applied; }).catch(() => {});
    // A step may still be running (another tab, or a reload mid-request).
    if (history.task?.status === 'running') watchRunningTask();
  }

  function watchRunningTask() {
    const timer = setInterval(async () => {
      try {
        const data = await api('GET', '/chat/history');
        appendMessages(data.messages);
        renderTask(data.task);
        applyTokens(data.tokens);
        if (data.task?.status !== 'running') clearInterval(timer);
      } catch {
        clearInterval(timer);
      }
    }, 2000);
  }

  function bindEvents() {
    const input = $('#question');
    $('#ask-form').addEventListener('submit', ask);
    input.addEventListener('input', () => { autoGrow(); updateAskButton(); schedulePreview(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!$('#btn-ask').disabled) ask();
      }
    });

    $('#btn-continue').addEventListener('click', () => taskAction('continue'));
    $('#btn-pause').addEventListener('click', () => taskAction(state.task?.status === 'paused' ? 'resume' : 'pause'));
    $('#btn-new-task').addEventListener('click', newTask);
    for (const button of $$('.segmented button')) button.addEventListener('click', () => setMode(button.dataset.mode));

    $('#btn-profile').addEventListener('click', openProfile);
    $('#profile-form').addEventListener('submit', saveProfile);
    $('#profile-clear').addEventListener('click', clearProfile);
    $('#profile-delete').addEventListener('click', () => { $('#profile-confirm').hidden = false; });
    $('#profile-delete-no').addEventListener('click', () => { $('#profile-confirm').hidden = true; });
    $('#profile-delete-yes').addEventListener('click', deleteProfile);

    for (const button of $$('[data-open-memory]')) button.addEventListener('click', () => openMemory(button.dataset.openMemory));
    for (const tab of $$('.tabs [role="tab"]')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));

    for (const dialog of $$('dialog')) {
      for (const close of $$('[data-close]', dialog)) close.addEventListener('click', () => dialog.close());
      // Click on the backdrop closes the dialog.
      dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    }
    $('#memory-dialog').addEventListener('close', () => { schedulePreview(); });

    $('#auth-form').addEventListener('submit', () => {
      storageSet('deepseek-agent-token', $('#auth-token').value || null);
      start();
    });
  }

  async function start() {
    clearError();
    try {
      await loadConfig();
      await loadState();
    } catch (err) {
      showError(err);
      updateEmpty();
    }
  }

  bindEvents();
  start();
})();
