import { Router } from 'express';

import { asyncRoute } from '../middleware.js';
import { CATEGORY_LABELS, INVARIANT_CATEGORIES, formatInvariants } from '../../invariants/invariantManager.js';
import { badRequest } from '../../utils/errors.js';
import { rejectUnknownFields, requireEnum, requireObject, requireText } from '../../utils/validate.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * GET    /api/invariants             every invariant (flat and grouped by category) + how the active ones are sent to DeepSeek
 * POST   /api/invariants             create {name, value, category?, enabled?, forbidden?, id?}
 * POST   /api/invariants/examples    add the example invariants (skips ids already taken)
 * POST   /api/invariants/check       dry-run the rule checker {text, type?: request|plan|response}
 * PUT    /api/invariants/:id         edit (any field but id), incl. enable/disable
 * DELETE /api/invariants/:id         delete
 */
export function createInvariantsRouter({ invariants, agent, tokenCounter }) {
  const router = Router();

  const view = async (extra = {}) => {
    const list = await invariants.list();
    const section = `[AGENT INVARIANTS]\n${formatInvariants(list)}`;
    return {
      invariants: list,
      grouped: await invariants.grouped(),
      active: list.filter((inv) => inv.enabled).length,
      categories: INVARIANT_CATEGORIES,
      categoryLabels: CATEGORY_LABELS,
      contextSection: section,
      contextTokens: tokenCounter.countText(section),
      tokens: await agent.tokenSummary(),
      ...extra,
    };
  };

  router.get('/invariants', asyncRoute(async (req, res) => res.json(await view())));

  router.post('/invariants', asyncRoute(async (req, res) => {
    const invariant = await invariants.create(requireObject(req.body));
    res.status(201).json(await view({ invariant }));
  }));

  router.post('/invariants/examples', asyncRoute(async (req, res) => {
    const added = await invariants.addExamples();
    res.status(added.length ? 201 : 200).json(await view({ added }));
  }));

  router.post('/invariants/check', asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['text', 'type']);
    const text = requireText(body.text, 'Text', { max: 20_000 });
    const type = requireEnum(body.type ?? 'request', 'type', ['request', 'plan', 'response', 'validation']);
    res.json(agent.checker.check({ type, text }, await invariants.list()));
  }));

  router.put('/invariants/:id', asyncRoute(async (req, res) => {
    const invariant = await invariants.update(invariantId(req.params.id), requireObject(req.body));
    res.json(await view({ invariant }));
  }));

  router.delete('/invariants/:id', asyncRoute(async (req, res) => {
    await invariants.delete(invariantId(req.params.id));
    res.json(await view({ deleted: true }));
  }));

  return router;
}

function invariantId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw badRequest('Invalid invariant id.');
  return value;
}
