'use strict';

// Runs the agent against a local stub endpoint: no API key, no network, no cost.
//
//   npm test

const http = require('http');
const assert = require('assert');

const agentModule = require('../agent/deepseekAgent');
const DeepSeekAgent = agentModule.DeepSeekAgent;

let passed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(function () {
    passed++;
    console.log('  ok   ' + name);
  }, function (err) {
    failures.push(name + ': ' + err.message);
    console.log('  FAIL ' + name + '\n       ' + err.message);
  });
}

/** A stub that answers every request the same way, and records what it got. */
function withStub(handler, fn) {
  return new Promise(function (resolve, reject) {
    const received = [];
    const server = http.createServer(function (req, res) {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* some tests send junk */ }
        received.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
        handler(req, res, received.length);
      });
    });
    server.listen(0, '127.0.0.1', function () {
      const url = 'http://127.0.0.1:' + server.address().port + '/chat/completions';
      Promise.resolve()
        .then(function () { return fn(url, received); })
        .then(function (v) { server.close(function () { resolve(v); }); },
              function (e) { server.close(function () { reject(e); }); });
    });
  });
}

function replyJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function answer(text) {
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}

function agentFor(url, extra) {
  const opts = { apiKey: 'sk-test-key', apiUrl: url };
  Object.keys(extra || {}).forEach(function (k) { opts[k] = extra[k]; });
  return new DeepSeekAgent(opts);
}

/** Assert that ask() rejects, and hand the error back for inspection. */
function rejects(promise) {
  return promise.then(function (value) {
    throw new Error('expected a rejection, got: ' + JSON.stringify(value));
  }, function (err) { return err; });
}

const HISTORY = [
  { role: 'user', content: 'My name is John.' },
  { role: 'assistant', content: 'Nice to meet you, John.' },
  { role: 'system', content: 'should never be replayed' },
  { role: 'user', content: '   ' }
];

(async function () {
  console.log('\nRequest shape');

  await test('sends the key as a bearer token and asks for JSON', function () {
    return withStub(function (req, res) { replyJson(res, 200, answer('hi')); }, function (url, got) {
      return agentFor(url).ask('hello', []).then(function () {
        assert.strictEqual(got[0].method, 'POST');
        assert.strictEqual(got[0].headers.authorization, 'Bearer sk-test-key');
        assert.strictEqual(got[0].headers['content-type'], 'application/json');
      });
    });
  });

  await test('replays the stored conversation ahead of the new question', function () {
    return withStub(function (req, res) { replyJson(res, 200, answer('John')); }, function (url, got) {
      return agentFor(url).ask('What is my name?', HISTORY).then(function () {
        const messages = got[0].body.messages;
        assert.strictEqual(messages[0].role, 'system', 'first message is the system prompt');
        assert.ok(/previous conversation history/.test(messages[0].content));
        assert.deepStrictEqual(messages.slice(1), [
          { role: 'user', content: 'My name is John.' },
          { role: 'assistant', content: 'Nice to meet you, John.' },
          { role: 'user', content: 'What is my name?' }
        ], 'stored turns in order, then the question');
      });
    });
  });

  await test('drops stored messages that are not usable turns', function () {
    return withStub(function (req, res) { replyJson(res, 200, answer('x')); }, function (url, got) {
      return agentFor(url).ask('q', HISTORY).then(function () {
        const roles = got[0].body.messages.map(function (m) { return m.role; });
        assert.ok(roles.indexOf('system') === roles.lastIndexOf('system'),
          'the stored system row was not replayed');
        assert.ok(got[0].body.messages.every(function (m) { return m.content.trim(); }),
          'the blank stored turn was not replayed');
      });
    });
  });

  await test('historyLimit keeps the most recent turns only', function () {
    return withStub(function (req, res) { replyJson(res, 200, answer('x')); }, function (url, got) {
      return agentFor(url, { historyLimit: 1 }).ask('q', HISTORY).then(function () {
        assert.deepStrictEqual(got[0].body.messages.slice(1), [
          { role: 'assistant', content: 'Nice to meet you, John.' },
          { role: 'user', content: 'q' }
        ]);
      });
    });
  });

  await test('sends the configured model and does not stream', function () {
    return withStub(function (req, res) { replyJson(res, 200, answer('x')); }, function (url, got) {
      return agentFor(url, { model: 'deepseek-reasoner' }).ask('q', []).then(function () {
        assert.strictEqual(got[0].body.model, 'deepseek-reasoner');
        assert.strictEqual(got[0].body.stream, false);
      });
    });
  });

  console.log('\nErrors the user has to act on');

  await test('404 names the endpoint instead of blaming the response format', function () {
    // The regression: a bare 404 has no JSON body, and reporting "not JSON"
    // hid the setting that was actually wrong.
    return withStub(function (req, res) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('');
    }, function (url) {
      return rejects(agentFor(url).ask('q', [])).then(function (err) {
        assert.ok(/HTTP 404/.test(err.message), err.message);
        assert.ok(/DEEPSEEK_API_URL/.test(err.message), 'points at the setting: ' + err.message);
        assert.ok(!/not JSON/.test(err.message), 'no longer reported as a format problem');
        assert.ok(err.message.indexOf(url) !== -1, 'names the URL actually used');
      });
    });
  });

  await test('an HTML error page still reports its status, not "not JSON"', function () {
    return withStub(function (req, res) {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html><body>Bad Gateway</body></html>');
    }, function (url) {
      return rejects(agentFor(url).ask('q', [])).then(function (err) {
        assert.ok(/unavailable right now \(HTTP 502\)/.test(err.message), err.message);
      });
    });
  });

  await test('401 points at the key', function () {
    return withStub(function (req, res) {
      replyJson(res, 401, { error: { message: 'Authentication Fails' } });
    }, function (url) {
      return rejects(agentFor(url).ask('q', [])).then(function (err) {
        assert.ok(/DEEPSEEK_API_KEY/.test(err.message), err.message);
      });
    });
  });

  await test('402 reports the account, 429 reports rate limiting', function () {
    return withStub(function (req, res, n) {
      replyJson(res, n === 1 ? 402 : 429, { error: { message: 'x' } });
    }, function (url) {
      return rejects(agentFor(url).ask('q', [])).then(function (err) {
        assert.ok(/out of credit/.test(err.message), err.message);
        return rejects(agentFor(url).ask('q', []));
      }).then(function (err) {
        assert.ok(/rate limiting/.test(err.message), err.message);
        assert.strictEqual(err.status, 429, 'the 429 is passed through to the browser');
      });
    });
  });

  await test('a 200 that is not JSON is still reported as a format problem', function () {
    return withStub(function (req, res) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>captive portal</html>');
    }, function (url) {
      return rejects(agentFor(url).ask('q', [])).then(function (err) {
        assert.ok(/not JSON/.test(err.message), err.message);
      });
    });
  });

  await test('an empty answer is rejected rather than stored', function () {
    return withStub(function (req, res) { replyJson(res, 200, answer('   ')); }, function (url) {
      return rejects(agentFor(url).ask('q', [])).then(function (err) {
        assert.ok(/empty answer/.test(err.message), err.message);
      });
    });
  });

  await test('a response with no message content is rejected', function () {
    return withStub(function (req, res) { replyJson(res, 200, { choices: [] }); }, function (url) {
      return rejects(agentFor(url).ask('q', [])).then(function (err) {
        assert.ok(/no message content/.test(err.message), err.message);
      });
    });
  });

  await test('a hung endpoint times out instead of hanging the request', function () {
    return withStub(function () { /* never answers */ }, function (url) {
      return rejects(agentFor(url, { timeoutMs: 300 }).ask('q', [])).then(function (err) {
        assert.strictEqual(err.status, 504);
        assert.ok(/did not answer within/.test(err.message), err.message);
      });
    });
  });

  await test('an empty question never reaches the network', function () {
    return withStub(function (req, res) { replyJson(res, 200, answer('x')); }, function (url, got) {
      return rejects(agentFor(url).ask('   ', [])).then(function (err) {
        assert.strictEqual(err.status, 400);
        assert.strictEqual(got.length, 0, 'no request was made');
      });
    });
  });

  console.log('\nEndpoint configuration');

  await test('a base URL is completed to the chat-completions path', function () {
    [['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
     ['https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions'],
     ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
     ['https://api.deepseek.com/chat/completions/', 'https://api.deepseek.com/chat/completions']
    ].forEach(function (pair) {
      assert.strictEqual(agentFor(pair[0]).apiUrl, pair[1], pair[0]);
    });
  });

  await test('an unset URL falls back to the documented endpoint', function () {
    assert.strictEqual(new DeepSeekAgent({ apiKey: 'sk-x' }).apiUrl,
      'https://api.deepseek.com/chat/completions');
  });

  await test('junk in DEEPSEEK_API_URL fails at startup, not at the first question', function () {
    assert.throws(function () { agentFor('not a url'); }, /not a valid URL/);
  });

  await test('a missing key fails at startup', function () {
    assert.throws(function () { new DeepSeekAgent({}); }, /DEEPSEEK_API_KEY/);
  });

  await test('describe() names the model and endpoint but never the key', function () {
    const label = agentFor('https://api.deepseek.com', { model: 'deepseek-chat' }).describe();
    assert.ok(label.indexOf('deepseek-chat') !== -1, label);
    assert.ok(label.indexOf('api.deepseek.com/chat/completions') !== -1, label);
    assert.ok(label.indexOf('sk-test-key') === -1, 'the key must never appear in a log line');
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) process.exit(1);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
