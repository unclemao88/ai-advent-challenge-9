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
  var requestTokensEl = document.getElementById('request-tokens');
  var errorEl = document.getElementById('error');
  var form = document.getElementById('form');
  var input = document.getElementById('question');
  var submitButton = document.getElementById('submit');

  // The same module the server counts with, so the two never disagree.
  var counter = window.TokenCounter;

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
    emptyState.hidden = true;
  }

  /** Replace the whole list, e.g. on first load. */
  function renderHistory(messages) {
    messagesEl.textContent = '';
    messages.forEach(function (message) {
      messagesEl.appendChild(renderBubble(message));
    });
    emptyState.hidden = messages.length > 0;
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

  /** The unsent question is counted locally, as the user types. */
  function updateRequestTokens() {
    var tokens = counter.estimateTokens(input.value);
    requestTokensEl.textContent = 'Current request: ' + counter.formatCount(tokens) + ' tokens';
    submitButton.disabled = busy || input.value.trim().length === 0;
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
