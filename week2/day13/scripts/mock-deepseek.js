#!/usr/bin/env node
/**
 * A local stand-in for DeepSeek's chat-completions endpoint, for smoke tests
 * and UI checks without spending API credit.
 *
 *   node scripts/mock-deepseek.js            # listens on 127.0.0.1:3999
 *   DEEPSEEK_API_URL=http://127.0.0.1:3999 DEEPSEEK_API_KEY=mock npm start
 *
 * It reads the state from the [CURRENT REQUEST] block and answers with the
 * JSON object the agent expects. Controls, via the user's message text:
 *   "fail validation"   the validation step fails (once per task)
 *   "ask me"            planning asks a question (needsUserInput)
 * Environment: MOCK_PORT (3999), MOCK_DELAY_MS (0), MOCK_FAIL_STATUS (e.g. 500: every call fails).
 *
 * GET /stats returns the number of requests served and the last request body.
 */
import http from 'node:http';

const port = Number(process.env.MOCK_PORT || 3999);
const delay = Number(process.env.MOCK_DELAY_MS || 0);
const failStatus = Number(process.env.MOCK_FAIL_STATUS || 0);
const failedValidationFor = new Set();
let served = 0;
let lastBody = null;

export function mockReply(messages) {
  const request = messages.at(-1)?.content ?? '';
  const state = request.match(/Current state: (\w+)/)?.[1] ?? 'planning';
  const taskId = request.match(/Task ID: ([\w-]+)/)?.[1] ?? 'unknown';
  const all = messages.map((m) => m.content).join('\n');
  const userText = request.split('User message:\n')[1]?.split('\n\nAnswer with')[0] ?? '';
  const profile = messages[0].content.match(/\[USER PROFILE\]\n([\s\S]*?)\n\n\[LONG-TERM MEMORY\]/)?.[1] ?? '';
  const styleNote = profile ? ` (profile applied: ${profile.split('\n')[0]})` : '';

  if (state === 'planning') {
    if (/ask me/i.test(userText)) {
      return { response: 'Which operating system should the plan target?', nextState: 'planning', plannedAction: 'Re-plan once the user answers.', needsUserInput: true, validation: null, workMemory: {}, memoryProposals: [] };
    }
    return {
      response: `**Plan**${styleNote}\n1. Understand the request\n2. Produce the answer\n3. Check it`,
      nextState: 'execution',
      plannedAction: 'Execute the three-step plan.',
      needsUserInput: false,
      validation: null,
      workMemory: { plan: ['Understand the request', 'Produce the answer', 'Check it'], requirements: ['Answer must be correct'], decisions: ['Use the mock backend'] },
      memoryProposals: [],
    };
  }
  if (state === 'execution') {
    return {
      response: `Here is the result${styleNote}.\n\n\`\`\`sh\necho "hello from the mock"\n\`\`\``,
      nextState: 'validation',
      plannedAction: 'Validate the result against the requirements.',
      needsUserInput: false,
      validation: null,
      workMemory: { result: 'Produced a one-line shell example.', facts: ['The mock was used'] },
      memoryProposals: [{ category: 'solutions', content: 'Print a greeting in sh with: echo "hello"' }],
    };
  }
  const shouldFail = /fail validation/i.test(all) && !failedValidationFor.has(taskId);
  if (shouldFail) failedValidationFor.add(taskId);
  return {
    response: shouldFail ? 'Validation failed: the example is missing a comment.' : 'Validation passed. The result meets every requirement.',
    nextState: shouldFail ? 'execution' : 'done',
    plannedAction: shouldFail ? 'Fix the missing comment.' : 'Finish the task.',
    needsUserInput: false,
    validation: { passed: !shouldFail, summary: shouldFail ? 'Missing a comment.' : 'All requirements met.' },
    workMemory: {},
    memoryProposals: [],
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
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
      process.stdout.write(`mock: ${body.messages.at(-1).content.match(/Current state: (\w+)/)?.[1]} (${body.messages.length} messages)\n`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Mock DeepSeek listening on http://127.0.0.1:${port}\n`));
}
