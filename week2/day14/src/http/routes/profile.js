import { Router } from 'express';

import { asyncRoute } from '../middleware.js';
import { PROFILE_FIELDS, formatProfile } from '../../profile/profileManager.js';

/**
 * GET    /api/profile           the profile (null when none) and how it is sent to DeepSeek
 * POST   /api/profile           create (409 when one exists)
 * PUT    /api/profile           create or update the given fields
 * POST   /api/profile/clear     empty every field, keep the profile
 * DELETE /api/profile           delete it
 *
 * Every change is applied to the very next request: the agent reads the
 * profile fresh for each context it builds.
 */
export function createProfileRouter({ profiles, agent, tokenCounter }) {
  const router = Router();

  const view = async (profile, status = 200) => {
    const section = `[USER PROFILE]\n${formatProfile(profile)}`;
    return {
      status,
      body: {
        profile,
        fields: PROFILE_FIELDS,
        contextSection: section,
        contextTokens: tokenCounter.countText(section),
        tokens: await agent.tokenSummary(),
      },
    };
  };
  const send = (res, { status, body }) => res.status(status).json(body);

  router.get('/profile', asyncRoute(async (req, res) => send(res, await view(await profiles.getProfile()))));
  router.post('/profile', asyncRoute(async (req, res) => send(res, await view(await profiles.createProfile(req.body), 201))));
  router.put('/profile', asyncRoute(async (req, res) => send(res, await view(await profiles.updateProfile(req.body)))));
  router.post('/profile/clear', asyncRoute(async (req, res) => send(res, await view(await profiles.clearProfile()))));
  router.delete('/profile', asyncRoute(async (req, res) => {
    const existed = await profiles.deleteProfile();
    const { body } = await view(null);
    res.json({ ...body, deleted: existed });
  }));

  return router;
}
