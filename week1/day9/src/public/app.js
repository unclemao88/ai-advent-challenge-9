/**
 * Front end. Talks only to this app's backend — never to DeepSeek, never sees
 * the key, never builds a prompt. It sends question text and renders the memory
 * state the backend returns.
 *
 * XSS: user text is always inserted with textContent. Model output (answers and
 * the summary) is rendered as Markdown by marked, then sanitized by DOMPurify
 * into a DOM fragment before it touches the page; if either library is missing
 * it falls back to textContent. The CSP header forbids inline scripts anyway.
 */
(function () {
  'use strict';

  var T = window.TokenService;

  function $(id) { return document.getElementById(id); }

  var app = $('app');
  var chat = $('chat');
  var messagesEl = $('messages');
  var emptyEl = $('empty');
  var noticesEl = $('notices');
  var errorEl = $('error');
  var form = $('form');
  var input = $('question');
  var askButton = $('ask');

  var busy = false;
  var maxChars = 8000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // --- Markdown ------------------------------------------------------------

  var markdownReady = Boolean(window.marked && window.DOMPurify && window.DOMPurify.isSupported);
  if (markdownReady) {
    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  /** Render untrusted model output. Never assigns raw HTML. */
  function renderMarkdown(target, text) {
    target.textContent = '';
    if (!markdownReady) {
      target.classList.add('plain');
      target.textContent = text;
      return;
    }
    var html = window.marked.parse(text, { gfm: true, breaks: true, headerIds: false, mangle: false });
    var fragment = window.DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
      FORBID_ATTR: ['style']
    });
    target.appendChild(fragment);
  }

  // --- Formatting ----------------------------------------------------------

  /** "13 Sep 2026, 16:21" in the viewer's local time. */
  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /** Put a token count into a <dd>, marking estimates visibly. */
  function setStat(id, value, estimated) {
    var node = $(id);
    node.textContent = '';
    if (value === null || value === undefined) {
      node.textContent = '—';
      return;
    }
    node.appendChild(document.createTextNode((estimated ? '~' : '') + T.format(value) + ' tokens'));
    if (estimated) {
      var mark = document.createElement('span');
      mark.className = 'est';
      mark.textContent = ' (estimated)';
      node.appendChild(mark);
    }
    node.title = estimated
      ? 'Estimated locally — DeepSeek does not publish a JavaScript tokenizer.'
      : 'Exact, from DeepSeek\'s usage report.';
  }

  // --- Rendering -----------------------------------------------------------

  function renderBubble(message, flags) {
    var isAgent = message.role === 'assistant';
    var bubble = document.createElement('article');
    bubble.className = 'bubble bubble--' + (isAgent ? 'agent' : 'user') + (flags.unanswered ? ' bubble--unanswered' : '');

    var head = document.createElement('div');
    head.className = 'bubble__head';
    var tag = document.createElement('span');
    tag.className = 'bubble__tag';
    tag.textContent = message.tag;
    var time = document.createElement('time');
    time.className = 'bubble__time';
    time.dateTime = message.timestamp;
    time.textContent = formatTime(message.timestamp);
    head.appendChild(tag);
    head.appendChild(time);
    bubble.appendChild(head);

    var body = document.createElement('div');
    body.className = 'bubble__body';
    if (isAgent) {
      body.classList.add('markdown');
      renderMarkdown(body, message.content);
    } else {
      body.classList.add('plain');
      body.textContent = message.content; // User text is never parsed as HTML.
    }
    bubble.appendChild(body);

    var foot = document.createElement('div');
    foot.className = 'bubble__foot';
    var tokens = document.createElement('span');
    tokens.textContent = T.label(message.tokens, message.tokensSource !== 'api');
    tokens.title = message.tokensSource === 'api'
      ? 'Exact: DeepSeek\'s completion token count for this answer.'
      : 'Estimated locally.';
    foot.appendChild(tokens);
    if (flags.unanswered) {
      var flag = document.createElement('span');
      flag.className = 'bubble__flag';
      flag.textContent = 'no answer — the request failed';
      foot.appendChild(flag);
    }
    bubble.appendChild(foot);
    return bubble;
  }

  function thinkingBubble() {
    var bubble = document.createElement('article');
    bubble.className = 'bubble bubble--agent bubble--pending';
    var head = document.createElement('div');
    head.className = 'bubble__head';
    var tag = document.createElement('span');
    tag.className = 'bubble__tag';
    tag.textContent = 'agent is thinking';
    head.appendChild(tag);
    bubble.appendChild(head);
    var dots = document.createElement('div');
    dots.className = 'thinking';
    for (var i = 0; i < 3; i += 1) dots.appendChild(document.createElement('i'));
    bubble.appendChild(dots);
    return bubble;
  }

  /** Render the whole memory state returned by the backend. */
  function renderMemory(memory) {
    var summary = memory.summary || {};
    var messages = memory.messages || [];
    var hasSummary = Boolean(summary.summary);

    // Historical summary — older conversation, never mixed with the bubbles.
    $('summary-body').hidden = !hasSummary;
    $('summary-foot').hidden = !hasSummary;
    if (hasSummary) {
      $('summary-note').textContent = 'Compressed memory of the older conversation — the '
        + plural(summary.messagesCovered, 'message') + ' before the recent history below are no longer sent in full.';
      renderMarkdown($('summary-body'), summary.summary);
      $('summary-tokens').textContent = 'Summary tokens: ' + T.label(summary.tokens, summary.tokensEstimated);
      $('summary-covered').textContent = 'Messages summarized: ' + summary.messagesCovered;
      $('summary-meta').textContent = summary.updatedAt ? 'updated ' + formatTime(summary.updatedAt) : '';
    } else {
      $('summary-note').textContent = 'No summary yet — the whole conversation still fits in the last '
        + memory.windowSize + ' messages, which are always kept in full.';
      $('summary-meta').textContent = '';
    }
    var pending = memory.pendingSummary || 0;
    $('summary-pending').hidden = pending === 0;
    $('summary-pending').textContent = pending
      ? plural(pending, 'older message') + ' not yet in the summary; ' + (pending === 1 ? 'it' : 'they')
        + ' will be folded in with the next question.'
      : '';

    // Recent full history.
    messagesEl.textContent = '';
    messages.forEach(function (message, i) {
      var next = messages[i + 1];
      var unanswered = message.role === 'user' && (next ? next.role === 'user' : !busy);
      messagesEl.appendChild(renderBubble(message, { unanswered: unanswered }));
    });
    emptyEl.hidden = messages.length > 0 || hasSummary;
    $('recent-meta').textContent = messages.length
      ? 'last ' + messages.length + ' of ' + plural(memory.totalMessages, 'message')
      : '';

    // Memory panel.
    var t = memory.tokens || {};
    setStat('stat-summary', t.summary, t.summaryEstimated);
    setStat('stat-history', t.fullHistory, t.fullHistoryEstimated);
    setStat('stat-total', t.historyTotal, t.historyTotalEstimated);
    $('stat-messages').textContent = plural(memory.totalMessages || 0, 'message') + ' stored · '
      + (summary.messagesCovered || 0) + ' summarized · ' + messages.length + ' in full';

    renderApiCall(memory.lastApiCall);
    renderNotices(memory.notices || []);
  }

  function renderApiCall(call) {
    setStat('stat-input', call ? call.input : null, call && call.estimated);
    setStat('stat-output', call ? call.output : null, call && call.estimated);
    setStat('stat-api-total', call ? call.total : null, call && call.estimated);
  }

  function renderSummarization(usage) {
    setStat('stat-sum-input', usage ? usage.input : null, usage && usage.estimated);
    setStat('stat-sum-output', usage ? usage.output : null, usage && usage.estimated);
    setStat('stat-sum-total', usage ? usage.total : null, usage && usage.estimated);
    $('stat-sum-note').textContent = usage
      ? 'Updated with the last question, in ' + plural(usage.calls, 'call') + '.'
      : 'The last question did not move any message into the summary.';
  }

  function renderNotices(notices) {
    noticesEl.textContent = '';
    notices.forEach(function (text) {
      var p = document.createElement('p');
      p.textContent = text;
      noticesEl.appendChild(p);
    });
    noticesEl.hidden = notices.length === 0;
  }

  // --- UI state ------------------------------------------------------------

  function scrollToBottom() {
    chat.scrollTop = chat.scrollHeight;
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function setBusy(state) {
    busy = state;
    askButton.textContent = state ? 'asking...' : 'ask';
    askButton.setAttribute('aria-busy', state ? 'true' : 'false');
    updateDraft();
  }

  /** Live, estimated count of the question being typed. */
  function updateDraft() {
    var tokens = T.count(input.value.trim());
    $('draft-tokens').textContent = input.value.trim()
      ? 'this question: ' + T.label(tokens, true)
      : '';
    askButton.disabled = busy || input.value.trim().length === 0;
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  // --- Backend -------------------------------------------------------------

  /** fetch + JSON, with the error payload attached to the thrown Error. */
  function requestJson(url, options) {
    return fetch(url, options).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
        if (!response.ok) {
          var err = new Error(payload && payload.error ? payload.error : 'The server responded with HTTP ' + response.status + '.');
          err.payload = payload || {};
          throw err;
        }
        if (!payload) throw new Error('The server sent a response that could not be read.');
        return payload;
      });
    });
  }

  function loadMemory() {
    return requestJson('/api/history').then(function (data) {
      if (data.maxQuestionChars) {
        maxChars = data.maxQuestionChars;
        input.maxLength = maxChars;
      }
      renderMemory(data);
      if (!data.agentConfigured) showError('The server has no DEEPSEEK_API_KEY configured, so questions cannot be answered yet.');
      return data;
    });
  }

  function ask(question) {
    clearError();
    setBusy(true);

    // Show the question immediately, with its (estimated) token count.
    var draft = {
      role: 'user', tag: 'you asked', content: question,
      timestamp: new Date().toISOString(), tokens: T.count(question), tokensSource: 'estimate'
    };
    var optimistic = renderBubble(draft, { unanswered: false });
    var thinking = thinkingBubble();
    messagesEl.appendChild(optimistic);
    messagesEl.appendChild(thinking);
    emptyEl.hidden = true;
    setStat('stat-request', draft.tokens, true);
    input.value = '';
    autoResize();
    updateDraft();
    scrollToBottom();

    requestJson('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question })
    }).then(function (data) {
      setBusy(false);
      renderMemory(data.memory);
      var t = data.tokens;
      setStat('stat-request', t.currentRequest, t.currentRequestEstimated);
      renderApiCall({ input: t.input, output: t.output, total: t.total, estimated: t.apiEstimated });
      renderSummarization(t.summarization);
      if (data.warnings && data.warnings.length) showError(data.warnings.join(' '));
      scrollToBottom();
    }).catch(function (err) {
      setBusy(false);
      var payload = err.payload || {};
      if (payload.memory) {
        // The question was stored; the re-render shows it as unanswered.
        renderMemory(payload.memory);
        showError(err.message + ' Your question was saved; no answer was stored.');
        scrollToBottom();
        return;
      }
      // Unknown whether it was stored (e.g. the network dropped): ask the server.
      optimistic.remove();
      thinking.remove();
      loadMemory().then(function (memory) {
        var last = memory.messages[memory.messages.length - 1];
        var stored = payload.userMessage || (last && last.role === 'user' && last.content === question);
        if (!stored && !input.value) {
          input.value = question; // Nothing saved: give the text back for a retry.
          autoResize();
          updateDraft();
        }
        showError(err.message + (stored ? ' Your question was saved; no answer was stored.' : ''));
        scrollToBottom();
      }, function () {
        if (!input.value) { input.value = question; autoResize(); updateDraft(); }
        showError(err.message);
      });
    }).then(function () {
      input.focus();
    });
  }

  function submit() {
    if (busy) return;
    var question = input.value.trim();
    if (!question) return;
    if (question.length > maxChars) {
      showError('That question is too long (limit ' + maxChars + ' characters).');
      return;
    }
    ask(question);
  }

  // --- Clear history (explicit, two-step confirmation) --------------------

  function setConfirming(on) {
    $('clear-confirm').hidden = !on;
    $('clear').hidden = on;
    if (on) $('clear-no').focus();
  }

  $('clear').addEventListener('click', function () { setConfirming(true); });
  $('clear-no').addEventListener('click', function () { setConfirming(false); });
  $('clear-yes').addEventListener('click', function () {
    if (busy) {
      showError('Wait for the current answer before clearing the history.');
      setConfirming(false);
      return;
    }
    requestJson('/api/history/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true })
    }).then(function (data) {
      clearError();
      renderMemory(data.memory);
      setStat('stat-request', null);
      renderSummarization(null);
    }).catch(function (err) {
      showError('Could not clear the history: ' + err.message);
    }).then(function () {
      setConfirming(false);
      input.focus();
    });
  });

  // --- Events --------------------------------------------------------------

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    submit();
  });

  input.addEventListener('keydown', function (event) {
    // Enter asks; Shift+Enter is a newline; never submit mid IME composition.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', function () {
    autoResize();
    updateDraft();
  });

  $('stats-toggle').addEventListener('click', function () {
    var open = app.classList.toggle('stats-open');
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  fetch('/api/health').then(function (r) { return r.json(); }).then(function (health) {
    $('model').textContent = health.model || '';
  }).catch(function () {});

  updateDraft();
  loadMemory().then(scrollToBottom, function (err) {
    showError('Could not load the stored history: ' + err.message);
  });
  input.focus();
})();
