import { Router } from 'express';

import { PROFILE_FIELDS, ProfileStore } from '../memory/profile.js';
import { HttpError } from '../utils/httpError.js';

/**
 * GET    /api/profile        the current profile and its field definitions
 * PUT    /api/profile        create or edit it; { style, format, limitations, name? }
 * POST   /api/profile/clear  empty every field, keep the record
 * DELETE /api/profile        delete it completely
 *
 * Every response carries the profile *and* fresh token counts, because
 * changing the profile changes the context of the next request.
 */
export function createProfileRouter({ agent, memory }) {
  const router = Router();

  router.get('/profile', async (req, res) => {
    res.json(await profileResponse({ agent, profile: await memory.profile.get() }));
  });

  router.put('/profile', async (req, res) => {
    const values = req.body?.profile ?? req.body;
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new HttpError(400, 'The profile must be a JSON object.', 'invalid_profile');
    }
    for (const [field, value] of Object.entries(values)) {
      if (!PROFILE_FIELDS[field]) continue; // Unknown keys are ignored, not an error.
      if (typeof value !== 'string') {
        throw new HttpError(400, `"${field}" must be text.`, 'invalid_profile');
      }
      if (value.length > PROFILE_FIELDS[field].max) {
        throw new HttpError(400, `"${field}" is too long (limit ${PROFILE_FIELDS[field].max} characters).`, 'invalid_profile');
      }
    }
    res.json(await profileResponse({ agent, profile: await memory.profile.save(values), saved: true }));
  });

  router.post('/profile/clear', async (req, res) => {
    res.json(await profileResponse({ agent, profile: await memory.profile.clearFields(), cleared: true }));
  });

  router.delete('/profile', async (req, res) => {
    res.json(await profileResponse({ agent, profile: await memory.profile.remove(), deleted: true }));
  });

  return router;
}

async function profileResponse({ agent, profile, ...flags }) {
  const { tokenCounts } = await agent.prepareRequest();
  return {
    profile,
    empty: ProfileStore.isEmpty(profile),
    fields: Object.entries(PROFILE_FIELDS).map(([id, { label, max, hint }]) => ({ id, label, max, hint })),
    tokens: tokenCounts,
    ...flags,
  };
}
