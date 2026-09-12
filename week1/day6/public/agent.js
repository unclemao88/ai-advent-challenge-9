(function (global) {
  'use strict';

  /**
   * Browser-side half of the Agent interface. It has exactly one method,
   *
   *   agent.ask(question) -> Promise<string>
   *
   * and knows only about this application's own /api/ask endpoint. The real
   * agent lives on the server; which provider is behind it is none of the
   * browser's business, and the API key never leaves the server.
   */
  function HttpAgent(endpoint) {
    this.endpoint = endpoint || '/api/ask';
  }

  HttpAgent.prototype.ask = function (question) {
    var text = String(question == null ? '' : question).trim();
    if (!text) return Promise.reject(new Error('Please enter a question.'));

    return fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text })
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        try { data = JSON.parse(raw); } catch (e) { /* handled below */ }

        if (!res.ok) {
          throw new Error((data && data.error) || ('Request failed (HTTP ' + res.status + ').'));
        }
        if (!data || typeof data.answer !== 'string') {
          throw new Error('The server returned an unexpected response.');
        }
        return data.answer;
      });
    }, function () {
      throw new Error('Could not reach the server. Check your connection and try again.');
    });
  };

  global.agent = new HttpAgent('/api/ask');
})(window);
