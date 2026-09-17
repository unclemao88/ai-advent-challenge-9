import { Router } from 'express';

import { asyncRoute } from '../middleware.js';
import { CATEGORIES, CATEGORY_LABELS, LIMITS as LT_LIMITS } from '../../memory/LongTermMemory.js';
import { badRequest, notFound } from '../../utils/errors.js';
import {
  isPlainObject, rejectUnknownFields, requireEnum, requireObject, requireRecordId, requireTaskId, requireText, requireUuid,
} from '../../utils/validate.js';

/**
 * GET    /api/memory                          overview: storage, token counts, sizes
 * GET    /api/memory/storage                  storage configuration per layer
 * PUT    /api/memory/storage                  change it (data is copied, never deleted)
 *
 * GET    /api/memory/short-term               the conversation
 * DELETE /api/memory/short-term               clear it
 * DELETE /api/memory/short-term/:messageId    delete one message
 *
 * GET    /api/memory/work                     work memory of the active task
 * GET    /api/memory/work/:taskId             … of a given task
 * PUT    /api/memory/work/:taskId             replace its editable fields
 * DELETE /api/memory/work/:taskId             clear it
 *
 * GET    /api/memory/long-term?q=&category=   everything, or a search
 * POST   /api/memory/long-term                save an entry
 * PUT    /api/memory/long-term/:id            edit an entry
 * DELETE /api/memory/long-term/:id            delete an entry
 * DELETE /api/memory/long-term?category=      clear a category (or all)
 */
export function createMemoryRouter({ agent, memory, tasks }) {
  const router = Router();

  router.get('/memory', asyncRoute(async (req, res) => {
    const active = await tasks.getActiveTask();
    const [messages, longTerm, work, tokens] = await Promise.all([
      memory.getShortTermMemory(),
      memory.getLongTermMemory(),
      active ? memory.getWorkMemory(active.taskId) : null,
      agent.tokenSummary(),
    ]);
    res.json({
      storage: memory.describeStorage(),
      tokens,
      shortTerm: { messages: messages.length, maxMessages: memory.config.shortTerm.maxMessages },
      work: { taskId: active?.taskId ?? null, memory: work },
      longTerm: Object.fromEntries(CATEGORIES.map((c) => [c, longTerm[c].length])),
    });
  }));

  // --- Storage configuration -----------------------------------------------

  router.get('/memory/storage', (req, res) => res.json({ storage: memory.describeStorage() }));

  router.put('/memory/storage', asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['layers', 'shortTerm']);
    const { storage, changes } = await memory.updateStorage(body);
    res.json({ storage, changes, tokens: await agent.tokenSummary() });
  }));

  // --- Short-term ------------------------------------------------------------

  router.get('/memory/short-term', asyncRoute(async (req, res) => {
    const messages = await memory.getShortTermMemory();
    res.json({ messages, tokens: await memory.shortTerm.calculateTokenCount(messages), maxMessages: memory.config.shortTerm.maxMessages });
  }));

  router.delete('/memory/short-term', asyncRoute(async (req, res) => {
    await memory.clearShortTermMemory();
    res.json({ cleared: true, tokens: await agent.tokenSummary() });
  }));

  router.delete('/memory/short-term/:messageId', asyncRoute(async (req, res) => {
    const id = requireUuid(req.params.messageId, 'message id');
    if (!(await memory.deleteMessage(id))) throw notFound('Message not found.');
    res.json({ deleted: true, tokens: await agent.tokenSummary() });
  }));

  // --- Work ------------------------------------------------------------------

  const workResponse = async (res, taskId) => {
    const work = await memory.getWorkMemory(taskId);
    res.json({ taskId, workMemory: work, tokens: memory.work.calculateTokenCount(work), summary: await agent.tokenSummary() });
  };

  router.get('/memory/work', asyncRoute(async (req, res) => {
    const active = await tasks.getActiveTask();
    if (!active) return res.json({ taskId: null, workMemory: null, tokens: 0 });
    return workResponse(res, active.taskId);
  }));

  router.get('/memory/work/:taskId', asyncRoute(async (req, res) => {
    const taskId = requireTaskId(req.params.taskId);
    await tasks.requireTask(taskId);
    return workResponse(res, taskId);
  }));

  router.put('/memory/work/:taskId', asyncRoute(async (req, res) => {
    const taskId = requireTaskId(req.params.taskId);
    await tasks.requireTask(taskId);
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['objective', 'plan', 'requirements', 'decisions', 'facts', 'variables']);
    const fields = {
      objective: requireText(body.objective ?? '', 'Objective', { min: 0, max: 1000 }),
      variables: {},
    };
    for (const name of ['plan', 'requirements', 'decisions', 'facts']) {
      const list = body[name] ?? [];
      if (!Array.isArray(list) || list.length > 30) throw badRequest(`${name} must be a list of at most 30 items.`);
      fields[name] = list.map((item) => requireText(item, `An item in ${name}`, { min: 0, max: 1000 })).filter(Boolean);
    }
    if (body.variables !== undefined) {
      if (!isPlainObject(body.variables)) throw badRequest('variables must be an object of name → text.');
      for (const [k, v] of Object.entries(body.variables)) {
        fields.variables[requireText(k, 'A variable name', { max: 60 })] = requireText(v, `Variable ${k}`, { min: 0, max: 500 });
      }
    }
    await memory.replaceWorkMemory(taskId, fields);
    return workResponse(res, taskId);
  }));

  router.delete('/memory/work/:taskId', asyncRoute(async (req, res) => {
    const taskId = requireTaskId(req.params.taskId);
    await tasks.requireTask(taskId);
    await memory.clearWorkMemory(taskId);
    return workResponse(res, taskId);
  }));

  // --- Long-term -------------------------------------------------------------

  const longTermResponse = async (res, extra = {}, status = 200) => {
    const all = await memory.getLongTermMemory();
    res.status(status).json({
      memory: all,
      categories: CATEGORY_LABELS,
      tokens: memory.longTerm.calculateTokenCount(all),
      summary: await agent.tokenSummary(),
      ...extra,
    });
  };

  router.get('/memory/long-term', asyncRoute(async (req, res) => {
    const category = requireEnum(req.query.category, 'category', CATEGORIES, { optional: true });
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const q = requireText(req.query.q, 'The search query', { max: 500 });
      return res.json({ query: q, results: await memory.searchMemory(q, { category, limit: 50 }) });
    }
    return longTermResponse(res);
  }));

  router.post('/memory/long-term', asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['category', 'content', 'tags', 'source']);
    const fact = {
      category: requireEnum(body.category, 'category', CATEGORIES),
      content: requireText(body.content, 'Content', { max: LT_LIMITS.content }),
      tags: parseTags(body.tags),
      source: requireEnum(body.source ?? 'user', 'source', ['user', 'proposal']),
    };
    const { fact: saved, created } = await memory.saveFact(fact);
    return longTermResponse(res, { fact: saved, created }, created ? 201 : 200);
  }));

  router.put('/memory/long-term/:id', asyncRoute(async (req, res) => {
    const id = requireRecordId(req.params.id);
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['category', 'content', 'tags']);
    const fact = await memory.updateFact(id, {
      category: requireEnum(body.category, 'category', CATEGORIES, { optional: true }),
      content: body.content === undefined ? undefined : requireText(body.content, 'Content', { max: LT_LIMITS.content }),
      tags: body.tags === undefined ? undefined : parseTags(body.tags),
    });
    if (!fact) throw notFound('Memory entry not found.');
    return longTermResponse(res, { fact });
  }));

  router.delete('/memory/long-term/:id', asyncRoute(async (req, res) => {
    const id = requireRecordId(req.params.id);
    if (!(await memory.deleteFact(id))) throw notFound('Memory entry not found.');
    return longTermResponse(res, { deleted: true });
  }));

  router.delete('/memory/long-term', asyncRoute(async (req, res) => {
    const category = requireEnum(req.query.category, 'category', CATEGORIES, { optional: true });
    await memory.clearMemory(category);
    return longTermResponse(res, { cleared: category ?? 'all' });
  }));

  return router;
}

function parseTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > LT_LIMITS.tags) throw badRequest(`tags must be a list of at most ${LT_LIMITS.tags} words.`);
  return tags.map((t) => requireText(t, 'A tag', { max: LT_LIMITS.tag }));
}
