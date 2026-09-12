(function () {
  'use strict';

  var history = document.getElementById('chat-history');
  var form = document.getElementById('ask-form');
  var input = document.getElementById('question');
  var button = document.getElementById('ask-button');
  var errorBox = document.getElementById('error');

  var busy = false;
  var pendingBubble = null;

  // --- Rendering -----------------------------------------------------------
  //
  // Every bubble is built with createElement and textContent. Nothing that
  // came from a user or from the model is ever parsed as HTML, so a question
  // like `<img src=x onerror=alert(1)>` is shown as that exact text.

  function addBubble(message) {
    removeEmptyState();

    var bubble = document.createElement('article');
    bubble.className = 'bubble ' + (message.role === 'user' ? 'user' : 'assistant');

    var tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = message.tag;

    var text = document.createElement('p');
    text.className = 'text';
    text.textContent = message.content;

    var time = document.createElement('time');
    time.className = 'time';
    time.dateTime = message.timestamp;
    time.textContent = formatTimestamp(message.timestamp);

    bubble.appendChild(tag);
    bubble.appendChild(text);
    bubble.appendChild(time);
    history.appendChild(bubble);
    return bubble;
  }

  /** The ISO string stays in the JSON file; the reader gets their own locale. */
  function formatTimestamp(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function showEmptyState() {
    if (history.querySelector('.bubble')) return;
    var note = document.createElement('p');
    note.className = 'empty';
    note.textContent = 'No messages yet. Ask the first question.';
    history.appendChild(note);
  }

  function removeEmptyState() {
    var note = history.querySelector('.empty');
    if (note) note.remove();
  }

  function scrollToNewest() {
    history.scrollTop = history.scrollHeight;
  }

  // --- Loading and error state ---------------------------------------------

  function showPending() {
    pendingBubble = addBubble({
      role: 'assistant',
      tag: 'agent answered',
      content: 'thinking',
      timestamp: new Date().toISOString()
    });
    pendingBubble.classList.add('pending');
    pendingBubble.querySelector('.text').classList.add('dots');
    pendingBubble.querySelector('.time').textContent = '';
    scrollToNewest();
  }

  function clearPending() {
    if (pendingBubble) pendingBubble.remove();
    pendingBubble = null;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function setBusy(value) {
    busy = value;
    input.disabled = value;
    button.textContent = value ? 'asking…' : 'ask';
    syncButton();
  }

  function syncButton() {
    button.disabled = busy || !input.value.trim();
  }

  // --- Server calls --------------------------------------------------------

  /** Read the JSON body whether the response succeeded or failed. */
  function readJson(res) {
    return res.text().then(function (raw) {
      var data = null;
      try { data = JSON.parse(raw); } catch (e) { /* handled by the caller */ }
      if (!res.ok) {
        throw new Error((data && data.error) || ('The server answered HTTP ' + res.status + '.'));
      }
      if (!data) throw new Error('The server sent a response that could not be read.');
      return data;
    });
  }

  function loadHistory() {
    return fetch('/api/history', { headers: { Accept: 'application/json' } })
      .then(readJson)
      .then(function (data) {
        (data.messages || []).forEach(addBubble);
        showEmptyState();
        scrollToNewest();
      })
      .catch(function (err) {
        showEmptyState();
        showError('Could not load the conversation: ' + err.message);
      });
  }

  function submit() {
    var question = input.value.trim();
    if (busy || !question) return;

    clearError();
    setBusy(true);

    // Show the question straight away, then replace it with the stored copy
    // (server id and timestamp) once the exchange has been saved.
    var optimistic = addBubble({
      role: 'user',
      tag: 'you asked',
      content: question,
      timestamp: new Date().toISOString()
    });
    input.value = '';
    scrollToNewest();
    showPending();

    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ question: question })
    }).then(readJson).then(function (data) {
      clearPending();
      optimistic.remove();
      addBubble(data.userMessage);
      addBubble(data.assistantMessage);
    }).catch(function (err) {
      // Nothing was stored, so take the question back out of the history and
      // hand the text back rather than inventing an answer.
      clearPending();
      optimistic.remove();
      showEmptyState();
      input.value = question;
      showError(err && err.message ? err.message : 'The request failed. Please try again.');
    }).then(function () {
      setBusy(false);
      scrollToNewest();
      input.focus();
    });
  }

  // --- Events --------------------------------------------------------------

  form.addEventListener('submit', function (event) {
    event.preventDefault(); // Never reload the page.
    submit();
  });

  // Enter sends; Shift+Enter keeps its usual newline in the textarea.
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', syncButton);

  syncButton();
  loadHistory();
})();
