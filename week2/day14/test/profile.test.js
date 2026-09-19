import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildApp, logger, requestedState, tempDir } from './helpers.js';
import { ProfileManager } from '../src/profile/profileManager.js';

test('profile: create, view, update, clear, delete — persisted in data/profile.json', async (t) => {
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
  const file = JSON.parse(await readFile(path.join(dir, 'profile.json'), 'utf8'));
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
