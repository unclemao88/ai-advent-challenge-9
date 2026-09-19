import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildApp, logger, requestedState, tempDir } from './helpers.js';
import { ProfileManager } from '../src/profile/profileManager.js';
import { ProfileChecker, parseProfileRules } from '../src/profile/profileChecker.js';

test('profile: create, view, edit, clear, delete — persisted in data/profile/profile.json', async (t) => {
  const dir = await tempDir(t);
  const profiles = new ProfileManager({ dataDir: dir, logger: logger() });
  await profiles.init();
  assert.equal(await profiles.getProfile(), null);

  const created = await profiles.createProfile({ style: 'concise', format: 'markdown', limitations: 'max 100 words' });
  assert.equal(created.style, 'concise');
  await assert.rejects(profiles.createProfile({ style: 'x' }), (err) => err.status === 409);

  await profiles.updateProfile({ format: 'plain text' });
  const reread = new ProfileManager({ dataDir: dir, logger: logger() });
  assert.deepEqual(
    (({ style, format, limitations }) => ({ style, format, limitations }))(await reread.getProfile()),
    { style: 'concise', format: 'plain text', limitations: 'max 100 words' },
  );
  const file = JSON.parse(await readFile(path.join(dir, 'profile', 'profile.json'), 'utf8'));
  assert.equal(file.profile.format, 'plain text');

  const cleared = await profiles.clearProfile();
  assert.deepEqual([cleared.style, cleared.format, cleared.limitations], ['', '', '']);
  assert.notEqual(await profiles.getProfile(), null, 'clear keeps the profile');

  assert.equal(await profiles.deleteProfile(), true);
  assert.equal(await profiles.getProfile(), null);
  await assert.rejects(profiles.clearProfile(), (err) => err.status === 404);
  await assert.rejects(profiles.updateProfile({ colour: 'blue' }), (err) => err.status === 400);
});

test('the profile is attached to every DeepSeek request, and edits apply to the next one', async (t) => {
  const { agent, profiles, llm, tasks } = await buildApp(t);
  await profiles.updateProfile({ style: 'pirate speak', format: 'bullet points', limitations: 'no emojis' });

  await agent.ask({ message: 'Explain HTTP caching', mode: 'auto' });
  assert.ok(llm.calls.length >= 3);
  for (const call of llm.calls) {
    const system = call.messages[0].content;
    assert.match(system, /\[USER PROFILE\]\nStyle: pirate speak\nFormat: bullet points\nLimitations: no emojis/);
  }

  await profiles.updateProfile({ style: 'formal' });
  await agent.startNewTask();
  await agent.ask({ message: 'Next question' });
  const last = llm.calls.at(-1);
  assert.equal(requestedState(last.messages), 'planning');
  assert.match(last.messages[0].content, /Style: formal/);
  assert.ok(await tasks.getActiveTask());

  await profiles.deleteProfile();
  await agent.startNewTask();
  await agent.ask({ message: 'Third question' });
  assert.match(llm.calls.at(-1).messages[0].content, /\[USER PROFILE\]\nNo profile is set/, 'even without a profile the section is present');
});

test('profile rules are read from the free-text fields', () => {
  assert.deepEqual(parseProfileRules({ style: 'friendly', format: 'bullet points', limitations: 'max 150 words, no code, no emojis' }),
    { maxWords: 150, noCode: true, noEmoji: true, bullets: true });
  assert.deepEqual(parseProfileRules({ style: '', format: 'plain text', limitations: 'English only' }), { plainText: true, language: 'english' });
  assert.deepEqual(parseProfileRules({ style: 'tables are fine', format: 'markdown', limitations: '' }), {}, 'a style remark is not a layout rule');
});

test('the profile checker flags responses that break the format and limitations', () => {
  const checker = new ProfileChecker();
  const profile = { style: 'concise', format: 'bullet points, plain text', limitations: 'max 12 words, no code, no emoji' };
  assert.deepEqual(checker.check(profile, '- Use Node.js\n- Keep it small').issues, []);
  const rules = (text) => checker.check(profile, text).issues.map((i) => i.rule);
  assert.deepEqual(rules('One two three four five six seven eight nine ten eleven twelve thirteen'), ['length', 'lists']);
  assert.deepEqual(rules('- run:\n```sh\nnpm start\n```'), ['code', 'markdown']);
  assert.deepEqual(rules('- **bold** 🚀'), ['markdown', 'emoji']);
  assert.ok(checker.check(null, 'anything at all').ok, 'no profile, no rules');
  assert.equal(checker.check({ limitations: 'reply in Russian' }, 'Hello there').issues[0].rule, 'language');
  assert.ok(checker.check({ limitations: 'reply in Russian' }, 'Привет, это ответ').ok);
});
