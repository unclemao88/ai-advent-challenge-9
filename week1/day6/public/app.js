(function () {
  'use strict';

  // This file is the UI and nothing else: it reads the field, calls
  // agent.ask(), and renders whatever comes back. It contains no provider
  // name, no endpoint, no model and no API details.
  var form = document.getElementById('ask-form');
  var input = document.getElementById('question');
  var button = document.getElementById('ask-btn');
  var spinner = document.getElementById('spinner');
  var buttonLabel = document.getElementById('ask-label');
  var responseBody = document.getElementById('response-body');
  var errorBox = document.getElementById('error');

  var PLACEHOLDER = 'The answer will appear here.';
  var busy = false;

  function syncButton() {
    button.disabled = busy || !input.value.trim();
  }

  function setBusy(value) {
    busy = value;
    spinner.classList.toggle('d-none', !value);
    buttonLabel.textContent = value ? 'Asking…' : 'Ask';
    syncButton();
  }

  function showPlaceholder(text) {
    responseBody.textContent = text;
    responseBody.classList.add('text-body-secondary', 'fst-italic');
  }

  function showAnswer(answer) {
    responseBody.textContent = answer;
    responseBody.classList.remove('text-body-secondary', 'fst-italic');
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('d-none');
  }

  function clearError() {
    errorBox.classList.add('d-none');
    errorBox.textContent = '';
  }

  function submit() {
    var question = input.value.trim();
    if (busy || !question) return;

    clearError();
    setBusy(true);
    showPlaceholder('Waiting for the answer…');

    agent.ask(question).then(function (answer) {
      showAnswer(answer);
    }).catch(function (err) {
      showPlaceholder(PLACEHOLDER);
      showError(err && err.message ? err.message : 'Something went wrong.');
    }).then(function () {
      setBusy(false);
      input.focus();
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault(); // Never reload the page.
    submit();
  });

  // Enter submits; Shift+Enter keeps its usual newline in the textarea.
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', syncButton);

  showPlaceholder(PLACEHOLDER);
  syncButton();
})();
