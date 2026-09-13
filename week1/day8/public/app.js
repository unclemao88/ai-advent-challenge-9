/**
 * Front end for the DeepSeek agent.
 *
 * It talks only to this application's own backend — never to DeepSeek, and it
 * never sees the API key. All chat content is inserted with textContent, so a
 * question or an answer containing HTML is shown as text and can never execute.
 */
(function () {
  'use strict';

  var chat = document.getElementById('chat');
  var messagesEl = document.getElementById('messages');
  var emptyState = document.getElementById('empty-state');
  var historyTokensEl = document.getElementById('history-tokens');
  var contextNoteEl = document.getElementById('context-note');
  var requestTokensEl = document.getElementById('request-tokens');
  var errorEl = document.getElementById('error');
  var form = document.getElementById('form');
  var input = document.getElementById('question');
  var submitButton = document.getElementById('submit');

  // The same modules the server uses, so the two never disagree.
  var counter = window.TokenCounter;
  var budgetRule = window.ContextBudget;

  // Per-message content tokens of the stored conversation, oldest first, plus
  // the budget parameters the server is using. Together these let the composer
  // work out what the next request will actually send, as the user types.
  var historyCosts = [];
  var contextParams = { budget: 0, systemTokens: 0, overhead: 0 };

  // One in-flight request at a time: the guard that makes a double submit
  // (button click, Ctrl+Enter, an impatient second click) a no-op.
  var busy = false;

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // --- Rendering -----------------------------------------------------------

  /**
   * Build one chat bubble: tag, text, timestamp, token count.
   *
   * @param {object} message A stored message from the backend.
   * @returns {HTMLElement}
   */
  function renderBubble(message) {
    var bubble = document.createElement('article');
    bubble.className = 'bubble bubble--' + (message.type === 'response' ? 'response' : 'request');

    var tag = document.createElement('div');
    tag.className = 'bubble__tag';
    tag.textContent = message.tag;
    bubble.appendChild(tag);

    var text = document.createElement('p');
    text.className = 'bubble__text';
    text.textContent = message.content; // Never innerHTML: this is untrusted text.
    bubble.appendChild(text);

    var meta = document.createElement('div');
    meta.className = 'bubble__meta';

    var when = document.createElement('span');
    when.textContent = formatTimestamp(message.timestamp);
    meta.appendChild(when);

    var tokens = document.createElement('span');
    var estimated = message.tokenSource !== 'api';
    tokens.textContent = (estimated ? '~' : '') + counter.formatCount(message.tokenCount) + ' tokens';
    tokens.title = estimated
      ? 'Estimated locally — DeepSeek does not publish a JavaScript tokenizer.'
      : 'Exact count reported by the DeepSeek API.';
    meta.appendChild(tokens);

    bubble.appendChild(meta);
    return bubble;
  }

  /** Append a message and reveal the list. */
  function addMessage(message) {
    messagesEl.appendChild(renderBubble(message));
    historyCosts.push(messageCost(message));
    emptyState.hidden = true;
  }

  /** Replace the whole list, e.g. on first load. */
  function renderHistory(messages) {
    messagesEl.textContent = '';
    historyCosts = [];
    messages.forEach(function (message) {
      messagesEl.appendChild(renderBubble(message));
      historyCosts.push(messageCost(message));
    });
    emptyState.hidden = messages.length > 0;
  }

  /**
   * What one stored message costs as context. The server's count wins where it
   * has one — it is exact for answers — and the text is estimated otherwise.
   */
  function messageCost(message) {
    var stored = Number(message.tokenCount);
    return isFinite(stored) && stored >= 0
      ? Math.round(stored)
      : counter.estimateTokens(message.content);
  }

  /** A placeholder bubble shown while DeepSeek is working. */
  function addPendingBubble() {
    var bubble = document.createElement('article');
    bubble.className = 'bubble bubble--response bubble--pending';

    var tag = document.createElement('div');
    tag.className = 'bubble__tag';
    tag.textContent = 'agent answered';
    bubble.appendChild(tag);

    var dots = document.createElement('div');
    dots.className = 'thinking';
    for (var i = 0; i < 3; i += 1) dots.appendChild(document.createElement('i'));
    bubble.appendChild(dots);

    messagesEl.appendChild(bubble);
    emptyState.hidden = true;
    return bubble;
  }

  /** "12 Sep 2026, 18:42" */
  function formatTimestamp(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.getDate() + ' ' + MONTHS[date.getMonth()] + ' ' + date.getFullYear()
      + ', ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // --- Counters and scrolling ---------------------------------------------

  /** The backend is authoritative for the stored total; we only display it. */
  function setHistoryTokens(count) {
    historyTokensEl.textContent = 'History: ' + counter.formatCount(count) + ' tokens';
  }

  /**
   * Say when the stored conversation no longer fits the context budget, so it
   * is visible that the agent is working from a window rather than everything
   * on screen. Nothing has been deleted — those messages are just not sent.
   */
  function setContextNote(context) {
    if (!context || !context.budget || !context.trimmedMessages) {
      contextNoteEl.hidden = true;
      contextNoteEl.textContent = '';
      return;
    }
    var count = context.trimmedMessages;
    contextNoteEl.textContent = count + ' older message' + (count === 1 ? '' : 's')
      + ' not sent — context budget ' + counter.formatCount(context.budget) + ' tokens';
    contextNoteEl.title = 'The whole conversation is still stored. Only the most recent '
      + context.includedMessages + ' messages fit the budget and were sent to DeepSeek.';
    contextNoteEl.hidden = false;
  }

  /**
   * What the next request will cost, counted locally as the user types.
   *
   * Not just the typed text: a request carries the system prompt and as much of
   * the stored conversation as the budget allows, and that is what gets billed.
   * The same shared rule the server applies decides how much history fits, so
   * this number is the one that will actually be sent — and it shrinks the
   * replayed history as the question grows, exactly as the server will.
   */
  function updateRequestTokens() {
    var questionTokens = counter.estimateTokens(input.value);
    var plan = budgetRule.plan(historyCosts, {
      budget: contextParams.budget,
      systemTokens: contextParams.systemTokens,
      questionTokens: questionTokens,
      overhead: contextParams.overhead
    });

    var text = 'Current request: ' + counter.formatCount(plan.estimatedTokens) + ' tokens';
    if (plan.historyTokens > 0 || questionTokens > 0) {
      text += ' (' + counter.formatCount(questionTokens) + ' new + '
        + counter.formatCount(plan.estimatedTokens - questionTokens) + ' context)';
    }
    requestTokensEl.textContent = text;

    submitButton.disabled = busy || input.value.trim().length === 0;
  }

  /** Remember the budget the server is enforcing, so the composer can apply it. */
  function setContextParams(context) {
    if (!context) return;
    contextParams = {
      budget: Number(context.budget) || 0,
      systemTokens: Number(context.systemTokens) || 0,
      overhead: Number(context.overhead) || 0
    };
  }

  /** Scrolls the chat pane only — never the page, which cannot scroll at all. */
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

  /** Grow the textarea with its content, up to the max height set in CSS. */
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  }

  function setBusy(state) {
    busy = state;
    input.disabled = state;
    submitButton.disabled = state || input.value.trim().length === 0;
    // The label stays "ask"; the busy state is carried by aria-busy and the CSS pulse.
    submitButton.setAttribute('aria-busy', state ? 'true' : 'false');
  }

  // --- Backend calls -------------------------------------------------------

  /**
   * Fetch JSON and turn any failure into an Error with a readable message.
   * A non-JSON body (a proxy page, a crash) must not surface as "Unexpected
   * token < in JSON".
   */
  function requestJson(url, options) {
    return fetch(url, options).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (err) {
            payload = null;
          }
        }
        if (!response.ok) {
          var message = payload && payload.error
            ? payload.error
            : 'The server responded with HTTP ' + response.status + '.';
          throw new Error(message);
        }
        if (!payload) throw new Error('The server sent a response that could not be read.');
        return payload;
      });
    });
  }

  /** Load the stored conversation. Runs on every page load, including reloads. */
  function loadHistory() {
    return requestJson('/api/history').then(function (data) {
      renderHistory(data.messages || []);
      setHistoryTokens(data.historyTokenCount || 0);
      setContextParams(data.context);
      setContextNote(data.context);
      updateRequestTokens();
      scrollToBottom();
    }).catch(function (err) {
      showError('Could not load the stored history: ' + err.message);
    });
  }

  /** Send a question, then render and account for both stored messages. */
  function ask(question) {
    clearError();
    setBusy(true);

    var pending = addPendingBubble();
    scrollToBottom();

    requestJson('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question })
    }).then(function (data) {
      pending.remove();
      addMessage(data.request);
      addMessage(data.response);
      setHistoryTokens(data.historyTokenCount);
      setContextParams(data.context);
      setContextNote(data.context);

      // Only clear the box once the exchange is safely stored and rendered, so
      // a failure never costs the user their typing.
      input.value = '';
      autoResize();
      updateRequestTokens();
      scrollToBottom();
    }).catch(function (err) {
      // Nothing was saved: show the failure plainly and keep the question.
      pending.remove();
      showError(err.message);
      scrollToBottom();
    }).then(function () {
      setBusy(false);
      updateRequestTokens();
      if (!busy) input.focus();
    });
  }

  function submit() {
    if (busy) return;                     // Ignore a second submit while one is running.
    var question = input.value.trim();
    if (!question) return;                // Nothing to ask.
    ask(question);
  }

  // --- Events --------------------------------------------------------------

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    submit();
  });

  input.addEventListener('input', function () {
    autoResize();
    updateRequestTokens();
    if (!errorEl.hidden) clearError();
  });

  // Enter inserts a newline, as in any textarea. Ctrl/Cmd + Enter sends.
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });

  // Keep the newest message in view when the window is resized.
  window.addEventListener('resize', scrollToBottom);

  updateRequestTokens();
  autoResize();
  loadHistory();
  input.focus();
})();
