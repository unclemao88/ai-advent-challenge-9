import { Router } from 'express';

import { listStorageModes } from '../memory/storageManager.js';
import { TOKENIZER } from '../agent/tokenCounter.js';
import { HttpError } from '../utils/httpError.js';

/**
 * GET  /api/memory        every layer's storage, contents and token count
 * POST /api/memory/clear  { layer, confirm? } — long-term needs confirm: true
 */
export function createMemoryRouter({ agent, memory }) {
  const router = Router();

  router.get('/memory', async (req, res) => {
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

/** The payload the memory panel and the settings dialog render from. */
export async function memoryOverview({ agent, memory }) {
  const [layers, { tokenCounts }] = await Promise.all([memory.describe(), agent.prepareRequest()]);
  return { layers, tokenCounts, storageModes: listStorageModes(), tokenizer: TOKENIZER };
}
