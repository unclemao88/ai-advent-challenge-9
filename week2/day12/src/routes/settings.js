import { Router } from 'express';

import { describeSettingsSchema, mergeSettings } from '../settings/settingsStore.js';
import { HttpError } from '../utils/httpError.js';
import { SerialQueue } from '../utils/serialQueue.js';
import { memoryOverview } from './memory.js';

/**
 * GET  /api/settings  current memory settings and what each layer allows
 * POST /api/settings  { memory: { <layer>: { storage, maxMessages?, maxEntries? } } }
 */
export function createSettingsRouter({ agent, memory, settingsStore }) {
  const router = Router();
  // Two saves in quick succession apply in order, never interleaved.
  const queue = new SerialQueue();

  router.get('/settings', (req, res) => {
    res.json({ settings: settingsStore.get(), schema: describeSettingsSchema() });
  });

  router.post('/settings', async (req, res) => {
    const settings = await queue.run(async () => {
      const { settings: next, errors } = mergeSettings(settingsStore.get(), req.body);
      if (errors.length) throw new HttpError(400, errors.join(' '), 'invalid_settings');

      // Apply before saving: if a switch fails, settings.json still describes
      // the storage the layers really use.
      await memory.applySettings(next.memory);
      return settingsStore.save(next);
    });

    res.json({ settings, ...(await memoryOverview({ agent, memory })) });
  });

  return router;
}
