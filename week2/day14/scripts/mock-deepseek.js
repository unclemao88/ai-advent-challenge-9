#!/usr/bin/env node
/**
 * A local stand-in for DeepSeek's chat-completions endpoint, for tests, smoke
 * tests and UI checks without spending API credit.
 *
 *   node scripts/mock-deepseek.js            # listens on 127.0.0.1:3999
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:3999 DEEPSEEK_API_KEY=mock npm start
 *
 * It reads the state from the [TASK STATE] block and answers with the JSON
 * object the agent expects. Controls, via words in the conversation:
 *   "ask me"            planning asks a question (needsUserInput)
 *   "fail validation"   the validation step fails (once per task)
 *   "python code"       execution first answers with a ```python block (the rule check
 *                       rejects it under a Node.js invariant); the revision answers in JS
 *   "always python"     execution keeps answering in Python (ends in a conflict)
 *   "model conflict"    planning reports a conflict with the first active invariant
 * Environment: MOCK_PORT (3999), MOCK_DELAY_MS (0), MOCK_FAIL_STATUS (e.g. 500: every call fails).
 *
 * GET /stats returns the number of requests served and the last request body.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const failedValidationFor = new Set();

export function mockReply(messages) {
  const last = messages.at(-1)?.content ?? '';
  const system = messages[0]?.content ?? '';
  const state = last.match(/Current state: (\w+)/)?.[1] ?? 'planning';
  const taskId = last.match(/Task ID: ([\w-]+)/)?.[1] ?? 'unknown';
  const all = messages.map((m) => m.content).join('\n');
  const userText = last.split('[CURRENT REQUEST]\n')[1]?.split('\n\nAnswer with')[0] ?? '';
  const profile = system.match(/\[USER PROFILE\]\n([\s\S]*?)\n\n\[AGENT INVARIANTS\]/)?.[1] ?? '';
  const styleNote = profile.startsWith('Style:') ? ` (profile applied — ${profile.split('\n')[0]})` : '';
  const firstInvariant = system.match(/\[AGENT INVARIANTS\]\n- \[([a-z0-9_-]+)\]/)?.[1];
  const revising = /REJECTED by the invariant check/.test(last);

  const base = { needsUserInput: false, invariantConflicts: [], validation: null, workMemory: {}, memoryProposals: [] };

  if (state === 'planning') {
    if (/ask me/i.test(userText)) {
      return { ...base, response: 'Which operating system should the plan target?', nextState: 'planning', plannedAction: 'Re-plan once the user answers.', needsUserInput: true };
    }
    if (/model conflict/i.test(all) && firstInvariant && !/KEEP the active invariants/.test(last)) {
      return {
        ...base,
        response: 'This request cannot be planned without breaking an active invariant.',
        nextState: 'planning',
        plannedAction: 'Ask the user whether the invariant should change.',
        invariantConflicts: [{ invariantId: firstInvariant, reason: 'The request needs a different stack than the invariant allows.' }],
      };
    }
    return {
      ...base,
      response: `**Plan**${styleNote}\n1. Understand the request\n2. Produce the answer in Node.js\n3. Check it against the invariants`,
      nextState: 'execution',
      plannedAction: 'Execute the three-step plan.',
      workMemory: { plan: ['Understand the request', 'Produce the answer in Node.js', 'Check it'], requirements: ['Answer must be correct'], decisions: ['Use the mock backend'] },
    };
  }
  if (state === 'execution') {
    const python = /always python/i.test(all) || (/python code/i.test(all) && !revising);
    return {
      ...base,
      response: python
        ? 'Here is the result:\n\n```python\nprint("hello from the mock")\n```'
        : `Here is the result${styleNote}.\n\n\`\`\`js\nconsole.log('hello from the mock');\n\`\`\``,
      nextState: 'validation',
      plannedAction: 'Validate the result against the requirements.',
      workMemory: { result: python ? 'Produced a Python example.' : 'Produced a one-line Node.js example.', facts: ['The mock was used'] },
      memoryProposals: [{ category: 'solutions', content: 'Print a greeting in Node.js with console.log("hello")' }],
    };
  }
  const shouldFail = /fail validation/i.test(all) && !failedValidationFor.has(taskId);
  if (shouldFail) failedValidationFor.add(taskId);
  return {
    ...base,
    response: shouldFail ? 'Validation failed: the example is missing a comment.' : 'Validation passed. The result meets every requirement and invariant.',
    nextState: shouldFail ? 'execution' : 'done',
    plannedAction: shouldFail ? 'Fix the missing comment.' : 'Finish the task.',
    validation: { passed: !shouldFail, summary: shouldFail ? 'Missing a comment.' : 'All requirements met.', issues: shouldFail ? ['Missing a comment'] : [] },
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createMockServer({ delay = 0, failStatus = 0, log = false } = {}) {
  let served = 0;
  let lastBody = null;
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/stats') return send(res, 200, { served, lastBody });
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return send(res, 404, { error: { message: 'not found' } });
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) return send(res, 401, { error: { message: 'missing key' } });

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      setTimeout(() => {
        served += 1;
        if (failStatus) return send(res, failStatus, { error: { message: 'mock failure' } });
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: { message: 'invalid JSON' } });
        }
        lastBody = body;
        const reply = mockReply(body.messages);
        const promptChars = body.messages.reduce((n, m) => n + m.content.length, 0);
        if (log) process.stdout.write(`mock: ${body.messages.at(-1).content.match(/Current state: (\w+)/)?.[1]} (${body.messages.length} messages)\n`);
        return send(res, 200, {
          id: `mock-${served}`,
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }],
          usage: { prompt_tokens: Math.round(promptChars / 4), completion_tokens: 50, total_tokens: Math.round(promptChars / 4) + 50 },
        });
      }, delay);
    });
    return undefined;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT || 3999);
  createMockServer({
    delay: Number(process.env.MOCK_DELAY_MS || 0), failStatus: Number(process.env.MOCK_FAIL_STATUS || 0), log: true,
  }).listen(port, '127.0.0.1', () => process.stdout.write(`Mock DeepSeek listening on http://127.0.0.1:${port}\n`));
}
