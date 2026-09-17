import { Router } from 'express';

import { TOKENIZER } from '../agent/tokenCounter.js';
import { WORK_FIELDS } from '../memory/workMemory.js';
import { PROFILE_FIELDS } from '../memory/profile.js';
import { describeSettingsSchema } from '../settings/settingsStore.js';
import { HttpError } from '../utils/httpError.js';

/**
 * GET  /api/memory                    every layer's storage, contents and token counts
 * PUT  /api/memory/work               replace work memory with an edited copy
 * PUT  /api/memory/long-term          replace solutions and knowledge
 * POST /api/memory/long-term/remove   { category, id } — delete one entry
 * POST /api/memory/clear              { layer, confirm? } — long-term needs confirm: true
 */
export function createMemoryRouter({ agent, memory }) {
  const router = Router();

  router.get('/memory', async (req, res) => {
    res.json(await memoryOverview({ agent, memory }));
  });

  router.put('/memory/work', async (req, res) => {
    const values = req.body?.work ?? req.body;
    if (!isObject(values)) throw new HttpError(400, 'Work memory must be a JSON object.', 'invalid_work_memory');
    await memory.work.replace(values);
    res.json(await memoryOverview({ agent, memory }));
  });

  router.put('/memory/long-term', async (req, res) => {
    const values = req.body?.longTerm ?? req.body;
    if (!isObject(values)) throw new HttpError(400, 'Long-term memory must be a JSON object.', 'invalid_long_term');
    for (const name of ['solutions', 'knowledge']) {
      if (values[name] !== undefined && !Array.isArray(values[name])) {
        throw new HttpError(400, `"${name}" must be a list.`, 'invalid_long_term');
      }
    }
    await memory.longTerm.replace(values);
    res.json(await memoryOverview({ agent, memory }));
  });

  router.post('/memory/long-term/remove', async (req, res) => {
    const { category, id } = req.body ?? {};
    if (category !== 'solutions' && category !== 'knowledge') {
      throw new HttpError(400, '"category" must be "solutions" or "knowledge".', 'invalid_category');
    }
    if (typeof id !== 'string' || !id) throw new HttpError(400, '"id" is required.', 'invalid_id');

    const removed = await memory.longTerm.removeEntry(category, id);
    if (!removed) throw new HttpError(404, 'That entry no longer exists.', 'entry_not_found');
    res.json(await memoryOverview({ agent, memory }));
  });

  router.post('/memory/clear', async (req, res) => {
    const layerId = req.body?.layer;
    memory.layer(layerId); // Validates the name before anything happens.

    // The UI asks the user first; the API insists on it too, so a stray call
    // cannot wipe what is meant to last.
    if (layerId === 'longTerm' && req.body?.confirm !== true) {
      throw new HttpError(400, 'Clearing long-term memory must be confirmed.', 'confirmation_required');
    }

    await memory.clear(layerId);
    res.json({ cleared: layerId, ...(await memoryOverview({ agent, memory })) });
  });

  return router;
}

/** The payload the memory panel and the memory dialog render from. */
export async function memoryOverview({ agent, memory }) {
  const [layers, { tokenCounts }] = await Promise.all([memory.describe(), agent.prepareRequest()]);
  return {
    layers,
    tokens: tokenCounts,
    schema: describeSettingsSchema(),
    // Field definitions travel with the data, so the editor in the browser is
    // always built from the shapes the server actually accepts.
    fields: {
      work: Object.entries(WORK_FIELDS).map(([id, { kind, label }]) => ({ id, kind, label })),
      profile: Object.entries(PROFILE_FIELDS).map(([id, { label, max, hint }]) => ({ id, label, max, hint })),
    },
    tokenizer: TOKENIZER,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
