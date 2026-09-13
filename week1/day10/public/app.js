/*
 * DeepSeek Agent — browser side.
 *
 * The server owns all state (data/state.json); this file only renders what
 * GET /api/state returns and sends user actions back. Every piece of user or
 * model text is inserted with textContent, never innerHTML.
 */
(function () {
  'use strict';

  var TokenService = window.TokenService;

  function $(id) { return document.getElementById(id); }

  var els = {
    chat: $('chat'),
    messages: $('messages'),
    empty: $('empty'),
    mode: $('mode'),
    panels: { 'sliding-window': $('panel-sliding'), 'sticky-facts': $('panel-sticky'), branching: $('panel-branching') },
    slidingN: $('sliding-n'),
    stickyN: $('sticky-n'),
    settingsError: $('settings-error'),
    contextSummary: $('context-summary'),
    branchSummary: $('branch-summary'),
    factsPanel: $('facts-panel'),
    factsToggle: $('facts-toggle'),
    factsCount: $('facts-count'),
    factsMeta: $('facts-meta'),
    factsEmpty: $('facts-empty'),
    factsBody: $('facts-body'),
    stat: {
      request: $('stat-request'),
      response: $('stat-response'),
      context: $('stat-context'),
      history: $('stat-history'),
      next: $('stat-next')
    },
    notices: $('notices'),
    form: $('composer'),
    question: $('question'),
    questionTokens: $('question-tokens'),
    ask: $('ask'),
    working: $('working'),
    workingText: $('working-text'),
    error: $('error'),
    branchControls: $('branch-controls'),
    enableCheckpoint: $('enable-checkpoint'),
    branchActive: $('branch-active'),
    switchBranch: $('switch-branch'),
    deleteCheckpoint: $('delete-checkpoint'),
    dialog: $('delete-dialog'),
    dialogForm: $('delete-form'),
    dialogOptions: $('delete-options'),
    dialogCancel: $('delete-cancel'),
    dialogConfirm: $('delete-confirm')
  };

  var STATUS_LABELS = {
    in: 'in AI context',
    out: 'outside AI context',
    facts: 'outside AI context · in facts',
    trimmed: 'trimmed to fit context limit'
  };

  var app = {
    state: null,
    busy: false,
    pendingPatch: null,
    settingsTimer: null,
    settingsChain: Promise.resolve(true),
    workingTimer: null
  };

  // --- HTTP ----------------------------------------------------------------

  function api(method, url, body) {
    var options = { method: method, headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(data && data.error ? data.error : 'The server answered HTTP ' + res.status + '.');
          err.status = res.status;
          throw err;
        }
        if (!data) throw new Error('The server returned an unreadable response.');
        return data;
      });
    }, function () {
      throw new Error('Cannot reach the local server. Is it running?');
    });
  }

  // --- Rendering -----------------------------------------------------------

  function render(state, options) {
    var opts = options || {};
    var nearBottom = isNearBottom();
    var previousScroll = els.chat.scrollTop;

    app.state = state;
    renderControls(state);
    renderFacts(state);
    renderMessages(state);
    renderStats(state);
    renderBranchControls(state);
    renderNotices(state);
    applyBusy();

    if (opts.scroll === 'bottom' || (opts.scroll !== 'keep' && nearBottom)) scrollToBottom();
    else els.chat.scrollTop = previousScroll;
  }

  function renderControls(state) {
    var cm = state.contextManagement;
    els.mode.value = cm.mode;
    Object.keys(els.panels).forEach(function (mode) { els.panels[mode].hidden = mode !== cm.mode; });
    setNumber(els.slidingN, cm.slidingWindow.N, cm.limits);
    setNumber(els.stickyN, cm.stickyFacts.N, cm.limits);

    var b = cm.branching;
    var active = findBranch(b, b.activeBranchId);
    if (b.checkpoint) {
      els.branchSummary.textContent = 'Checkpoint after message ' + b.checkpoint.baseMessageCount + ' · '
        + (active ? active.name : '') + ' — active';
    } else {
      els.branchSummary.textContent = 'No checkpoint. Use "Enable checkpoint" below the ask button.';
    }

    var ctx = state.context;
    var parts = [
      'Visible history: ' + plural(state.history.visibleMessages, 'message'),
      'Active AI context: ' + plural(ctx.historyIds.length, 'message')
        + (cm.mode === 'sticky-facts' ? ' + ' + plural(ctx.factsCount, 'fact') : '')
        + ' (~' + TokenService.format(ctx.estimatedTokens) + ' tokens)'
    ];
    if (ctx.uncoveredIncluded > 0) parts.push(plural(ctx.uncoveredIncluded, 'older message') + ' not yet in facts, sent in full');
    if (ctx.trimmedIds.length > 0) parts.push(plural(ctx.trimmedIds.length, 'message') + ' trimmed to fit the context limit');
    if (b.checkpoint && cm.mode !== 'branching') parts.push('checkpoint exists: ' + (active ? active.name : '') + ' active (manage it in Branching mode)');
    if (state.history.storedMessages !== state.history.visibleMessages) {
      parts.push('stored in all branches: ' + plural(state.history.storedMessages, 'message'));
    }
    els.contextSummary.textContent = parts.join(' · ');
  }

  function setNumber(input, value, limits) {
    input.min = limits.min;
    input.max = limits.max;
    if (input.dataset.dirty !== '1') input.value = String(value);
  }

  function renderFacts(state) {
    var cm = state.contextManagement;
    var sf = cm.stickyFacts;
    els.factsPanel.hidden = cm.mode !== 'sticky-facts';
    els.factsCount.textContent = '(' + sf.facts.length + ')';
    els.factsEmpty.hidden = sf.facts.length > 0;

    var meta = [];
    var branch = findBranch(cm.branching, sf.branchId);
    if (cm.branching.checkpoint && branch) meta.push('Facts of ' + branch.name);
    meta.push('cover the first ' + plural(sf.messagesCovered, 'message') + ' of the conversation');
    if (sf.updatedAt) meta.push('updated ' + formatTimestamp(sf.updatedAt));
    if (sf.lastError) meta.push('last extraction failed: ' + sf.lastError.message + ' (previous facts kept)');
    els.factsMeta.textContent = meta.join(' · ');

    els.factsBody.textContent = '';
    sf.facts.forEach(function (fact) {
      var row = document.createElement('tr');
      row.appendChild(node('td', 'facts__key', fact.key));
      row.appendChild(node('td', 'facts__value', fact.value));
      row.appendChild(node('td', 'facts__time', fact.updatedAt ? formatTimestamp(fact.updatedAt) : '—'));
      els.factsBody.appendChild(row);
    });
  }

  function renderMessages(state) {
    var messages = state.messages;
    var checkpoint = state.contextManagement.branching.checkpoint;
    var fragment = document.createDocumentFragment();

    var firstIn = -1;
    for (var i = 0; i < messages.length; i += 1) {
      if (messages[i].contextStatus === 'in') { firstIn = i; break; }
    }

    if (checkpoint && !checkpoint.afterMessageId) fragment.appendChild(checkpointDivider(state));
    messages.forEach(function (message, index) {
      if (index === firstIn && index > 0) fragment.appendChild(contextDivider(messages.slice(0, index)));
      fragment.appendChild(bubble(message, state));
      if (checkpoint && message.id === checkpoint.afterMessageId) fragment.appendChild(checkpointDivider(state));
    });
    if (messages.length > 0 && firstIn === -1) fragment.appendChild(contextDivider(messages));

    els.messages.textContent = '';
    els.messages.appendChild(fragment);
    els.empty.hidden = messages.length > 0;
  }

  function bubble(message, state) {
    var isRequest = message.type === 'request';
    var el = node('article', 'msg ' + (isRequest ? 'msg--request' : 'msg--response') + ' msg--ctx-' + message.contextStatus);
    el.dataset.id = message.id;

    var head = node('header', 'msg__head');
    head.appendChild(node('span', 'msg__label', isRequest ? 'you asked' : 'agent answered'));
    var time = node('time', 'msg__time', formatTimestamp(message.timestamp));
    time.dateTime = message.timestamp;
    time.title = new Date(message.timestamp).toString();
    head.appendChild(time);
    el.appendChild(head);

    el.appendChild(renderContent(message.content));

    var meta = node('footer', 'msg__meta');
    meta.appendChild(node('span', 'msg__tokens', 'Tokens: ' + tokenText(message.tokens, message.tokensSource)));
    if (!isRequest && message.finishReason === 'length') meta.appendChild(node('span', 'badge badge--warn', 'cut off'));
    if (message.branchId !== 'main') {
      var branch = findBranch(state.contextManagement.branching, message.branchId);
      if (branch) meta.appendChild(node('span', 'badge badge--branch', branch.name));
    }
    meta.appendChild(node('span', 'badge badge--' + message.contextStatus, STATUS_LABELS[message.contextStatus] || ''));
    el.appendChild(meta);
    return el;
  }

  /** Plain text with ``` fenced blocks shown as code. No HTML is interpreted. */
  function renderContent(text) {
    var body = node('div', 'msg__body');
    var parts = String(text).split('```');
    parts.forEach(function (part, i) {
      var isCode = i % 2 === 1 && i < parts.length - 1;
      if (isCode) {
        var newline = part.indexOf('\n');
        var firstLine = newline === -1 ? '' : part.slice(0, newline).trim();
        var hasLang = newline !== -1 && /^[\w+#.-]*$/.test(firstLine);
        var pre = node('pre', 'msg__code');
        if (hasLang && firstLine) pre.dataset.lang = firstLine;
        pre.appendChild(node('code', '', (hasLang ? part.slice(newline + 1) : part).replace(/\n$/, '')));
        body.appendChild(pre);
      } else {
        var chunk = (i % 2 === 1 ? '```' : '') + part;
        chunk = chunk.replace(/^\n+|\n+$/g, '');
        if (chunk) body.appendChild(node('div', 'msg__text', chunk));
      }
    });
    return body;
  }

  function contextDivider(outside) {
    var counts = { facts: 0, out: 0, trimmed: 0 };
    outside.forEach(function (m) { if (counts[m.contextStatus] !== undefined) counts[m.contextStatus] += 1; });
    var details = [];
    if (counts.facts) details.push(counts.facts + ' represented by sticky facts');
    if (counts.trimmed) details.push(counts.trimmed + ' trimmed to fit the context limit');
    var text = '▲ outside active AI context: ' + plural(outside.length, 'message')
      + (details.length ? ' (' + details.join(', ') + ')' : '') + '   ▼ active AI context';
    return node('div', 'divider divider--context', text);
  }

  function checkpointDivider(state) {
    var b = state.contextManagement.branching;
    var active = findBranch(b, b.activeBranchId);
    return node('div', 'divider divider--checkpoint', '⎇ checkpoint · ' + (active ? active.name : '') + ' — active');
  }

  function renderStats(state) {
    var turn = state.lastTurn;
    var stats = state.statistics;
    els.stat.request.textContent = turn ? tokenText(turn.requestTokens, turn.requestTokensSource) : '—';
    els.stat.response.textContent = turn ? tokenText(turn.responseTokens, turn.responseTokensSource) : '—';
    els.stat.context.textContent = turn ? tokenText(turn.contextTokens, turn.contextTokensSource) : '—';
    els.stat.history.textContent = (stats.estimated ? '~' : '') + TokenService.format(stats.totalTokens) + ' tokens';
    els.stat.history.parentNode.title = 'Sum of the token counts of every stored message, in all branches ('
      + TokenService.format(stats.totalRequestTokens) + ' in questions, estimated; '
      + TokenService.format(stats.totalResponseTokens) + ' in answers, from DeepSeek). DeepSeek API usage so far: '
      + TokenService.format(stats.api.totalTokens) + ' tokens in ' + stats.api.calls + ' calls ('
      + stats.api.factExtractionCalls + ' for sticky facts).';
    renderNextContext();
  }

  function renderNextContext() {
    if (!app.state) return;
    var question = els.question.value;
    var questionTokens = question.trim() ? TokenService.count(question) + TokenService.MESSAGE_OVERHEAD_TOKENS : 0;
    var total = app.state.context.estimatedTokens + questionTokens;
    els.stat.next.textContent = '~' + TokenService.format(total) + ' tokens';
    els.stat.next.classList.toggle('over', total > app.state.agent.contextBudgetTokens);
    els.questionTokens.textContent = question.trim()
      ? 'Question: ~' + TokenService.format(TokenService.count(question)) + ' tokens (estimated) · Shift+Enter for a new line'
      : 'Enter to send · Shift+Enter for a new line';
  }

  function renderBranchControls(state) {
    var cm = state.contextManagement;
    var b = cm.branching;
    var has = Boolean(b.checkpoint);
    els.branchControls.hidden = cm.mode !== 'branching';
    els.enableCheckpoint.hidden = has;
    els.branchActive.hidden = !has;
    els.switchBranch.hidden = !has;
    els.deleteCheckpoint.hidden = !has;
    if (has) {
      var active = findBranch(b, b.activeBranchId);
      var other = b.branches.filter(function (br) { return !br.isBase && !br.active; })[0];
      els.branchActive.textContent = (active ? active.name : '') + ' — active';
      els.switchBranch.title = other ? 'Switch to ' + other.name : '';
    }
  }

  function renderNotices(state) {
    var notices = [];
    if (!state.agent.configured) {
      notices.push('DEEPSEEK_API_KEY is not set on the server. The history is shown, but questions will fail until the key is configured and the server restarted.');
    }
    state.notices.forEach(function (n) { notices.push(n); });
    els.notices.textContent = '';
    notices.forEach(function (text) { els.notices.appendChild(node('p', 'notice', text)); });
    els.notices.hidden = notices.length === 0;
  }

  // --- Busy state ----------------------------------------------------------

  function setBusy(busy, label) {
    app.busy = busy;
    clearInterval(app.workingTimer);
    if (busy) {
      var started = Date.now();
      var base = label || 'agent is working…';
      els.workingText.textContent = base;
      app.workingTimer = setInterval(function () {
        els.workingText.textContent = base + ' ' + Math.round((Date.now() - started) / 1000) + 's';
      }, 1000);
    }
    applyBusy();
  }

  function applyBusy() {
    var busy = app.busy;
    els.ask.disabled = busy;
    els.working.hidden = !busy;
    els.question.readOnly = busy;
    els.form.setAttribute('aria-busy', busy ? 'true' : 'false');
    [els.mode, els.slidingN, els.stickyN, els.enableCheckpoint, els.switchBranch, els.deleteCheckpoint].forEach(function (el) {
      el.disabled = busy;
    });
  }

  // --- Settings ------------------------------------------------------------

  function onModeChange() {
    queuePatch({ mode: els.mode.value });
    flushSettings();
  }

  function onWindowInput(input, section, label) {
    input.dataset.dirty = '1';
    clearTimeout(app.settingsTimer);
    var limits = app.state ? app.state.contextManagement.limits : { min: 1, max: 500 };
    var value = input.value.trim();
    var n = Number(value);
    if (!/^\d+$/.test(value) || n < limits.min || n > limits.max) {
      showSettingsError(label + ' must be a whole number from ' + limits.min + ' to ' + limits.max + '.');
      if (app.pendingPatch) delete app.pendingPatch[section];
      return;
    }
    hideSettingsError();
    var patch = {};
    patch[section] = { N: n };
    queuePatch(patch);
    app.settingsTimer = setTimeout(flushSettings, 400);
  }

  function queuePatch(patch) {
    app.pendingPatch = Object.assign(app.pendingPatch || {}, patch);
  }

  /** Send queued settings. Resolves true when everything queued was saved. */
  function flushSettings() {
    clearTimeout(app.settingsTimer);
    var patch = app.pendingPatch;
    app.pendingPatch = null;
    if (!patch || !Object.keys(patch).length) {
      return app.settingsChain.then(function () { return !els.settingsError.textContent || els.settingsError.hidden; });
    }
    app.settingsChain = app.settingsChain.then(function () {
      return api('POST', '/api/context', patch);
    }).then(function (result) {
      if (patch.slidingWindow) delete els.slidingN.dataset.dirty;
      if (patch.stickyFacts) delete els.stickyN.dataset.dirty;
      hideSettingsError();
      render(result.state, { scroll: 'keep' });
      return true;
    }).catch(function (err) {
      showSettingsError(err.message);
      return loadState('keep').then(function () { return false; }, function () { return false; });
    });
    return app.settingsChain;
  }

  // --- Asking --------------------------------------------------------------

  function onSubmit(event) {
    event.preventDefault();
    if (app.busy) return;

    var text = els.question.value;
    if (!text.trim()) {
      showError('Please type a question first.');
      els.question.focus();
      return;
    }
    var max = app.state ? app.state.agent.maxQuestionChars : 8000;
    if (text.length > max) {
      showError('The question is too long (' + text.length + ' characters, the limit is ' + max + ').');
      return;
    }

    hideError();
    setBusy(true);
    var pending = pendingBubble(text);

    flushSettings().then(function (saved) {
      if (!saved) throw new Error('Fix the context settings first.');
      return api('POST', '/api/ask', { question: text });
    }).then(function (result) {
      pending.remove();
      els.question.value = '';
      autoResize();
      setBusy(false);
      render(result.state, { scroll: 'bottom' });
      if (result.warnings && result.warnings.length) showError(result.warnings.join(' '), 'warning');
    }).catch(function (err) {
      pending.remove();
      setBusy(false);
      showError('The request failed: ' + err.message + ' Your question was not saved; it is still in the input box.');
    }).then(function () {
      els.question.focus();
    });
  }

  /** A temporary "you asked" bubble while waiting. Never persisted. */
  function pendingBubble(text) {
    var el = node('article', 'msg msg--request msg--pending');
    var head = node('header', 'msg__head');
    head.appendChild(node('span', 'msg__label', 'you asked'));
    head.appendChild(node('time', 'msg__time', formatTimestamp(new Date().toISOString())));
    el.appendChild(head);
    el.appendChild(renderContent(text));
    el.appendChild(node('footer', 'msg__meta', 'sending…'));
    els.messages.appendChild(el);
    els.empty.hidden = true;
    scrollToBottom();
    return el;
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!app.busy) els.form.requestSubmit ? els.form.requestSubmit() : onSubmit(event);
  }

  // --- Branching -----------------------------------------------------------

  function branchAction(request, label) {
    if (app.busy) return;
    hideError();
    setBusy(true, label);
    flushSettings().then(request).then(function (result) {
      setBusy(false);
      render(result.state, { scroll: 'bottom' });
    }).catch(function (err) {
      setBusy(false);
      showError(err.message);
    });
  }

  function openDeleteDialog() {
    var b = app.state && app.state.contextManagement.branching;
    if (!b || !b.checkpoint || app.busy) return;
    els.dialogOptions.textContent = '';
    b.branches.filter(function (br) { return !br.isBase; }).forEach(function (br) {
      var label = node('label', 'radio');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'branch';
      input.value = br.id;
      input.addEventListener('change', function () { els.dialogConfirm.disabled = false; });
      label.appendChild(input);
      label.appendChild(node('span', '', br.name + (br.active ? ' (active)' : '')));
      label.appendChild(node('span', 'muted', plural(br.ownMessages, 'message') + ' after the checkpoint'));
      els.dialogOptions.appendChild(label);
    });
    els.dialogConfirm.disabled = true;
    els.dialog.hidden = false;
    els.dialogCancel.focus();
  }

  function closeDeleteDialog() {
    els.dialog.hidden = true;
    els.deleteCheckpoint.focus();
  }

  function onDeleteConfirm(event) {
    event.preventDefault();
    var selected = els.dialogForm.querySelector('input[name="branch"]:checked');
    if (!selected) {
      els.dialogConfirm.disabled = true;
      return;
    }
    els.dialog.hidden = true;
    branchAction(function () {
      return api('POST', '/api/checkpoint/delete', { branchId: selected.value });
    }, 'deleting branch…');
  }

  // --- Helpers -------------------------------------------------------------

  function node(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function findBranch(branching, id) {
    return branching.branches.filter(function (br) { return br.id === id; })[0] || null;
  }

  function tokenText(value, source) {
    if (typeof value !== 'number') return '—';
    return source === 'api' ? TokenService.format(value) : '~' + TokenService.format(value) + ' (estimated)';
  }

  function plural(n, word) {
    return TokenService.format(n) + ' ' + word + (n === 1 ? '' : 's');
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** Local "2026-09-13 18:42:10". */
  function formatTimestamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function isNearBottom() {
    return els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 40;
  }

  function scrollToBottom() {
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  function autoResize() {
    els.question.style.height = 'auto';
    els.question.style.height = Math.min(els.question.scrollHeight + 2, Math.round(window.innerHeight * 0.3)) + 'px';
  }

  function showError(text, kind) {
    els.error.textContent = text;
    els.error.className = 'alert' + (kind === 'warning' ? ' alert--warning' : '');
    els.error.hidden = false;
  }

  function hideError() {
    els.error.hidden = true;
    els.error.textContent = '';
  }

  function showSettingsError(text) {
    els.settingsError.textContent = text;
    els.settingsError.hidden = false;
  }

  function hideSettingsError() {
    els.settingsError.hidden = true;
    els.settingsError.textContent = '';
  }

  function loadState(scroll) {
    return api('GET', '/api/state').then(function (state) {
      render(state, { scroll: scroll || 'bottom' });
    });
  }

  // --- Wiring --------------------------------------------------------------

  els.form.addEventListener('submit', onSubmit);
  els.question.addEventListener('keydown', onKeyDown);
  els.question.addEventListener('input', function () { autoResize(); renderNextContext(); });
  els.mode.addEventListener('change', onModeChange);
  els.slidingN.addEventListener('input', function () { onWindowInput(els.slidingN, 'slidingWindow', 'Number of messages'); });
  els.stickyN.addEventListener('input', function () { onWindowInput(els.stickyN, 'stickyFacts', 'Keep latest messages'); });
  [els.slidingN, els.stickyN].forEach(function (input) {
    input.addEventListener('change', function () { if (app.pendingPatch) flushSettings(); });
  });
  els.factsPanel.addEventListener('toggle', function () {
    els.factsToggle.textContent = els.factsPanel.open ? 'hide' : 'show';
  });

  els.enableCheckpoint.addEventListener('click', function () {
    branchAction(function () { return api('POST', '/api/checkpoint'); }, 'creating checkpoint…');
  });
  els.switchBranch.addEventListener('click', function () {
    branchAction(function () { return api('POST', '/api/branch/switch', {}); }, 'switching branch…');
  });
  els.deleteCheckpoint.addEventListener('click', openDeleteDialog);
  els.dialogCancel.addEventListener('click', closeDeleteDialog);
  els.dialogForm.addEventListener('submit', onDeleteConfirm);
  els.dialog.addEventListener('click', function (event) { if (event.target === els.dialog) closeDeleteDialog(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !els.dialog.hidden) closeDeleteDialog();
  });

  loadState('bottom').catch(function (err) {
    showError('Could not load the conversation: ' + err.message);
  });
})();
