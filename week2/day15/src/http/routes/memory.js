import { Router } from 'express';

import { asyncRoute } from '../middleware.js';
import { STORED_CATEGORIES } from '../../memory/longTermMemory.js';
import { PROMOTABLE_FIELDS, TEXT_LISTS } from '../../memory/workMemory.js';
import { badRequest } from '../../utils/errors.js';
import {
  rejectUnknownFields, requireEnum, requireInt, requireObject, requireTaskId, requireText,
} from '../../utils/validate.js';

const LTM_ID = /^ltm_[a-z0-9]{1,40}$/;

/**
 * GET    /api/memory                           all three layers (separately) + token counts + storage
 * GET    /api/memory/short-term                short-term memory
 * DELETE /api/memory/short-term                clear it (the visible chat history stays)
 * DELETE /api/memory/short-term/:id            forget one message
 * GET    /api/memory/work                      work memory of every task (?taskId= for one)
 * POST   /api/memory/work/:taskId/items        add {field, content}
 * PUT    /api/memory/work/:taskId/items        edit {field, index, content}
 * DELETE /api/memory/work/:taskId/items        remove {field, index}
 * DELETE /api/memory/work/:taskId              clear a task's work memory
 * GET    /api/memory/long-term                 profile + solutions + knowledge (?q= shows what a query retrieves)
 * POST   /api/memory/long-term                 add {category, content, tags?, pinned?}
 * PUT    /api/memory/long-term/:id             edit {content?, tags?, pinned?, category?}
 * DELETE /api/memory/long-term/:id             delete one entry
 * POST   /api/memory/promote                   work → long-term {taskId, field, index?, category, content?, tags?}
 * GET    /api/memory/storage                   storage provider of each layer
 * PUT    /api/memory/storage                   change it {shortTerm?: {provider, options}, work?, longTerm?, shortTermMaxMessages?}
 */
export function createMemoryRouter({ agent, memory, tasks, config }) {
  const router = Router();
  const summary = () => agent.tokenSummary();

  router.get('/memory', asyncRoute(async (req, res) => {
    const active = await tasks.getActiveTask();
    const [shortTerm, work, longTerm, tokens] = await Promise.all([
      memory.getShortTermMemory(),
      active ? memory.getWorkMemory(active.id) : Promise.resolve(null),
      memory.getLongTermMemory(),
      summary(),
    ]);
    res.json({
      shortTerm: { messages: shortTerm, tokens: tokens.shortTerm },
      work: { taskId: active?.id ?? null, memory: work, tokens: tokens.work },
      longTerm: { ...longTerm, tokens: tokens.longTerm },
      tokens,
      storage: memory.describeStorage(),
    });
  }));

  // --- Short-term -------------------------------------------------------------

  router.get('/memory/short-term', asyncRoute(async (req, res) => {
    const messages = await memory.getShortTermMemory();
    res.json({ messages, tokens: memory.shortTerm.calculateTokenCount(messages), storage: memory.describeStorage().layers.shortTerm });
  }));

  router.delete('/memory/short-term', asyncRoute(async (req, res) => {
    await memory.clearShortTermMemory();
    res.json({ messages: [], tokens: await summary() });
  }));

  router.delete('/memory/short-term/:id', asyncRoute(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw badRequest('Invalid message id.');
    await memory.deleteMemory('shortTerm', req.params.id);
    res.json({ deleted: true, tokens: await summary() });
  }));

  // --- Work -------------------------------------------------------------------

  router.get('/memory/work', asyncRoute(async (req, res) => {
    const active = await tasks.getActiveTask();
    if (req.query.taskId !== undefined) {
      const taskId = requireTaskId(req.query.taskId);
      await tasks.requireTask(taskId);
      return res.json({ taskId, memory: await memory.getWorkMemory(taskId), activeTaskId: active?.id ?? null });
    }
    return res.json({
      activeTaskId: active?.id ?? null,
      tasks: await memory.getAllWorkMemory(),
      tokens: (await summary()).work,
      storage: memory.describeStorage().layers.work,
    });
  }));

  const workItem = (req, { needIndex, needContent }) => {
    const taskId = requireTaskId(req.params.taskId);
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['field', 'index', 'content']);
    const field = requireEnum(body.field, 'field', needIndex ? [...TEXT_LISTS, 'plan'] : TEXT_LISTS);
    const index = needIndex ? requireInt(body.index, 'index', { min: 0, max: 100 }) : undefined;
    const content = needContent ? requireText(body.content, 'Content', { max: 1000 }) : undefined;
    return { taskId, field, index, content };
  };

  router.post('/memory/work/:taskId/items', asyncRoute(async (req, res) => {
    const { taskId, field, content } = workItem(req, { needIndex: false, needContent: true });
    await tasks.requireTask(taskId);
    const doc = await memory.addMemory('work', { taskId, field, content });
    res.status(201).json({ memory: doc, tokens: await summary() });
  }));

  router.put('/memory/work/:taskId/items', asyncRoute(async (req, res) => {
    const { taskId, field, index, content } = workItem(req, { needIndex: true, needContent: true });
    const doc = await memory.updateMemory('work', { taskId, field, index }, { content });
    res.json({ memory: doc, tokens: await summary() });
  }));

  router.delete('/memory/work/:taskId/items', asyncRoute(async (req, res) => {
    const { taskId, field, index } = workItem(req, { needIndex: true, needContent: false });
    await memory.deleteMemory('work', { taskId, field, index });
    res.json({ memory: await memory.getWorkMemory(taskId), tokens: await summary() });
  }));

  router.delete('/memory/work/:taskId', asyncRoute(async (req, res) => {
    const taskId = requireTaskId(req.params.taskId);
    await tasks.requireTask(taskId);
    res.json({ memory: await memory.clearWorkMemory(taskId), tokens: await summary() });
  }));

  // --- Long-term --------------------------------------------------------------

  router.get('/memory/long-term', asyncRoute(async (req, res) => {
    const longTerm = await memory.getLongTermMemory();
    const out = { ...longTerm, tokens: (await summary()).longTerm, storage: memory.describeStorage().layers.longTerm };
    if (req.query.q !== undefined) {
      const q = requireText(req.query.q, 'q', { min: 0, max: 2000 });
      out.retrieval = await memory.retrieveLongTerm(q, config.agent.longTermContextTokens);
    }
    res.json(out);
  }));

  router.post('/memory/long-term', asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['category', 'content', 'tags', 'pinned', 'source']);
    const entry = {
      category: requireEnum(body.category, 'category', STORED_CATEGORIES),
      content: requireText(body.content, 'Content', { max: 2000 }),
      tags: tagList(body.tags),
      pinned: optionalBool(body.pinned, 'pinned') ?? false,
      source: requireEnum(body.source ?? 'user', 'source', ['user', 'proposal', 'promotion']),
    };
    const result = await memory.addMemory('longTerm', entry);
    res.status(result.created ? 201 : 200).json({ ...result, longTerm: await memory.getLongTermMemory(), tokens: await summary() });
  }));

  router.put('/memory/long-term/:id', asyncRoute(async (req, res) => {
    const id = entryId(req.params.id);
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['category', 'content', 'tags', 'pinned']);
    const changes = {
      content: body.content === undefined ? undefined : requireText(body.content, 'Content', { max: 2000 }),
      tags: body.tags === undefined ? undefined : tagList(body.tags),
      pinned: optionalBool(body.pinned, 'pinned'),
      category: requireEnum(body.category, 'category', STORED_CATEGORIES, { optional: true }),
    };
    const entry = await memory.updateMemory('longTerm', id, changes);
    res.json({ entry, tokens: await summary() });
  }));

  router.delete('/memory/long-term/:id', asyncRoute(async (req, res) => {
    await memory.deleteMemory('longTerm', entryId(req.params.id));
    res.json({ deleted: true, tokens: await summary() });
  }));

  router.post('/memory/promote', asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['taskId', 'field', 'index', 'category', 'content', 'tags']);
    const taskId = requireTaskId(body.taskId);
    await tasks.requireTask(taskId);
    const result = await memory.promoteToLongTerm({
      taskId,
      field: requireEnum(body.field, 'field', PROMOTABLE_FIELDS),
      index: requireInt(body.index, 'index', { min: 0, max: 100, optional: true }),
      category: requireEnum(body.category, 'category', STORED_CATEGORIES),
      content: body.content === undefined ? undefined : requireText(body.content, 'Content', { max: 2000 }),
      tags: tagList(body.tags),
    });
    res.status(result.created ? 201 : 200).json({ ...result, tokens: await summary() });
  }));

  // --- Storage ----------------------------------------------------------------

  router.get('/memory/storage', (req, res) => res.json(memory.describeStorage()));

  router.put('/memory/storage', asyncRoute(async (req, res) => {
    const result = await memory.updateStorage(requireObject(req.body));
    res.json({ ...result, tokens: await summary() });
  }));

  return router;
}

function entryId(value) {
  if (typeof value !== 'string' || !LTM_ID.test(value)) throw badRequest('Invalid memory id.');
  return value;
}

function tagList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw badRequest('"tags" must be a list of at most 10 tags.');
  return value.map((t) => requireText(t, 'Tag', { max: 40 }));
}

function optionalBool(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`"${name}" must be true or false.`);
  return value;
}

