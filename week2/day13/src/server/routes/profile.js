import { Router } from 'express';

import { asyncRoute } from '../middleware.js';
import { PROFILE_FIELDS, formatProfile, hasProfileContent } from '../../profile/ProfileManager.js';
import { notFound } from '../../utils/errors.js';

/**
 * GET    /api/profile         view (profile is null when none exists)
 * POST   /api/profile         create (409 if one exists)
 * PUT    /api/profile         save every field (creates if missing)
 * PATCH  /api/profile         change some fields
 * POST   /api/profile/clear   empty every field
 * DELETE /api/profile         delete
 *
 * Every answer includes fresh token counts: the profile is part of every request.
 */
export function createProfileRouter({ agent, profiles }) {
  const router = Router();

  const respond = async (res, profile, status = 200, extra = {}) => {
    res.status(status).json({
      profile,
      exists: Boolean(profile),
      applied: hasProfileContent(profile),
      fields: PROFILE_FIELDS,
      contextText: formatProfile(profile),
      tokens: await agent.tokenSummary(),
      ...extra,
    });
  };

  router.get('/profile', asyncRoute(async (req, res) => respond(res, await profiles.getProfile())));
  router.post('/profile', asyncRoute(async (req, res) => respond(res, await profiles.createProfile(req.body), 201)));
  router.put('/profile', asyncRoute(async (req, res) => respond(res, await profiles.saveProfile(req.body))));
  router.patch('/profile', asyncRoute(async (req, res) => respond(res, await profiles.updateProfile(req.body))));
  router.post('/profile/clear', asyncRoute(async (req, res) => respond(res, await profiles.clearProfile())));

  router.delete('/profile', asyncRoute(async (req, res) => {
    const existed = await profiles.deleteProfile();
    if (!existed) throw notFound('There is no profile to delete.', 'profile_not_found');
    return respond(res, null, 200, { deleted: true });
  }));

  return router;
}
